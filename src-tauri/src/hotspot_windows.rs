//! Windows Mobile Hotspot with a bounded, ownership-aware 5 GHz fallback.
//! The policy runs in tests on every desktop; only the driver uses WinRT.
use super::Session;

#[derive(Clone, PartialEq, Eq)]
struct Configuration {
    ssid: String,
    password: String,
    band: i32,           // TetheringWiFiBand: Auto=0, 2.4=1, 5=2.
    authentication: i32, // WPA2=0. Retain a user's WPA3 configuration on restore.
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Off,
    On,
    Busy,
}
enum Started {
    Ready,
    BandUnavailable,
}
trait Driver {
    fn state(&self) -> Result<State, String>;
    fn configuration(&self) -> Result<Configuration, String>;
    fn configure(&self, configuration: &Configuration) -> Result<(), String>;
    fn supports_5ghz(&self) -> Result<bool, String>;
    fn start(&self) -> Result<Started, String>;
    fn stop(&self) -> Result<(), String>;
    fn address(&self) -> Option<String> {
        None
    }
}

fn new_private_address(
    before: &[std::net::Ipv4Addr],
    now: &[std::net::Ipv4Addr],
) -> Option<String> {
    let mut added: Vec<_> = now
        .iter()
        .copied()
        .filter(|ip| ip.is_private() && !before.contains(ip))
        .collect();
    added.sort_unstable();
    added.dedup();
    (added.len() == 1).then(|| added[0].to_string())
}

struct Host<D: Driver> {
    driver: D,
    previous: Configuration,
    owned: Configuration,
    attempted: Option<Configuration>,
    session: Session,
}
impl<D: Driver> Host<D> {
    fn prepare(driver: D, ssid: String, password: String) -> Result<Self, String> {
        if driver.state()? != State::Off {
            return Err("A system hotspot is already active or changing. Turn it off in Windows Settings before creating a PulseDrop hotspot.".into());
        }
        let previous = driver.configuration()?;
        let band = if driver.supports_5ghz()? { 2 } else { 1 };
        Ok(Self {
            driver,
            previous,
            attempted: None,
            owned: Configuration {
                ssid: ssid.clone(),
                password: password.clone(),
                band,
                authentication: 0,
            },
            session: Session {
                role: "host",
                ssid,
                password,
                address: None,
                network_info: None,
            },
        })
    }
    fn owns_configuration(&self) -> Result<bool, String> {
        let current = self.driver.configuration()?;
        Ok(current == self.owned || self.attempted.as_ref() == Some(&current))
    }
    fn is_active(&self) -> Result<bool, String> {
        Ok(self.driver.state()? == State::On && self.owns_configuration()?)
    }
    fn activate(&mut self) -> Result<(), String> {
        // Never replace a profile changed in Settings while setup was pending.
        if self.driver.state()? != State::Off || self.driver.configuration()? != self.previous {
            return Err(
                "Windows hotspot settings changed. Keep your selected network, or retry setup."
                    .into(),
            );
        }
        self.driver.configure(&self.owned)?;
        let mut fallback = self.owned.band == 1;
        if matches!(self.driver.start()?, Started::BandUnavailable) {
            if self.owned.band != 2 {
                return Err("Windows could not start a 2.4 GHz hotspot. Use system hotspot settings or another receiver.".into());
            }
            if !self.owns_configuration()? {
                return Err("Windows hotspot settings changed during setup.".into());
            }
            if self.driver.state()? == State::On {
                self.driver.stop()?;
            }
            if self.driver.state()? != State::Off {
                return Err("Windows is still changing the hotspot. Stop it and retry.".into());
            }
            // Keep the old ownership identity until configuration has completed.
            let mut compatible = self.owned.clone();
            compatible.band = 1;
            self.attempted = Some(compatible.clone());
            self.driver.configure(&compatible)?;
            self.owned = compatible;
            self.attempted = None;
            fallback = true;
            if !matches!(self.driver.start()?, Started::Ready) {
                return Err("Windows could not start a compatible hotspot. Use system settings or another receiver.".into());
            }
        }
        if !self.is_active()? {
            return Err("Windows did not activate the requested hotspot.".into());
        }
        self.session.address = self.driver.address();
        self.session.network_info = Some(if fallback {
            "Configured for 2.4 GHz. 5 GHz was unavailable; Windows selects the channel and width."
        } else { "Configured for 5 GHz. Windows selects the channel and width." }.into());
        Ok(())
    }
    fn stop(&self) -> Result<(), String> {
        // A timed-out WinRT operation may still be settling, even before it
        // publishes our SSID. Keep the lease until it can be checked safely.
        let state = self.driver.state()?;
        if state == State::Busy {
            return Err("Windows is still changing the hotspot. Wait a moment and choose Stop hotspot again.".into());
        }
        if !self.owns_configuration()? {
            return Ok(());
        }
        match state {
            State::On => self.driver.stop()?,
            State::Off => {},
            State::Busy => return Err("Windows is still changing the hotspot. Wait a moment and choose Stop hotspot again.".into()),
        }
        // Recheck after the async operation: never undo a user's newer choice.
        if self.owns_configuration()? {
            if self.driver.state()? != State::Off {
                return Err("Windows has not finished stopping the hotspot. Wait a moment and retry cleanup.".into());
            }
            self.driver.configure(&self.previous)?;
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::{
        sync::Mutex,
        thread,
        time::{Duration, Instant},
    };
    use windows::{
        core::HSTRING,
        Networking::{Connectivity::NetworkInformation, NetworkOperators::*},
        Win32::{
            Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
            System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
    };
    const SETTINGS: &str = "Windows hotspot control is unavailable. Open Mobile hotspot settings and select 5 GHz, or use an Android/Linux receiver. Windows may require an internet-connected sharing profile and Wi-Fi control permission.";
    // Every Tauri blocking worker initializes its own WinRT apartment. Managers
    // and configurations are agile WinRT objects, safe to retain between calls.
    pub(super) struct Runtime(bool);
    impl Runtime {
        pub(super) fn enter() -> Result<Self, String> {
            match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
                Ok(()) => Ok(Self(true)),
                // App exit can run on an existing STA; the agile manager also
                // works there. Do not uninitialize an apartment we do not own.
                Err(error) if error.code().0 as u32 == 0x80010106 => Ok(Self(false)),
                Err(_) => Err(SETTINGS.into()),
            }
        }
    }
    impl Drop for Runtime {
        fn drop(&mut self) {
            if self.0 {
                unsafe { RoUninitialize() };
            }
        }
    }
    fn os<T>(result: windows::core::Result<T>) -> Result<T, String> {
        result.map_err(|_| SETTINGS.into())
    }
    // Cancellation bounds the worker. The retained Host lets Stop retry cleanup
    // if Windows is still finishing a timed-out operation.
    type Pending = Box<dyn Fn() -> windows::core::Result<bool> + Send + Sync>;
    fn wait(
        pending: &Mutex<Option<Pending>>,
        status: Pending,
        cancel: impl Fn(),
    ) -> Result<(), String> {
        let mut pending = pending
            .lock()
            .map_err(|_| "Windows hotspot state unavailable")?;
        *pending = Some(status);
        let deadline = Instant::now() + Duration::from_secs(25);
        while os(pending.as_ref().unwrap()())? {
            if Instant::now() >= deadline {
                cancel();
                return Err("Windows hotspot setup timed out. Choose Stop hotspot, or check Mobile hotspot in Windows Settings.".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
        *pending = None;
        Ok(())
    }
    fn addresses() -> Vec<std::net::Ipv4Addr> {
        if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|interface| match interface.addr {
                if_addrs::IfAddr::V4(address) => Some(address.ip),
                _ => None,
            })
            .collect()
    }
    pub(super) struct Windows(
        NetworkOperatorTetheringManager,
        Mutex<Option<Pending>>,
        Vec<std::net::Ipv4Addr>,
    );
    impl Windows {
        fn new() -> Result<Self, String> {
            let profile = os(NetworkInformation::GetInternetConnectionProfile())?;
            if os(
                NetworkOperatorTetheringManager::GetTetheringCapabilityFromConnectionProfile(
                    &profile,
                ),
            )? != TetheringCapability::Enabled
            {
                return Err(SETTINGS.into());
            }
            let manager =
                os(NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile))?;
            // The band API needs Windows 10 2004+. Older systems keep guided setup.
            os(os(manager.GetCurrentAccessPointConfiguration())?.Band())?;
            Ok(Self(manager, Mutex::new(None), addresses()))
        }
    }
    impl Driver for Windows {
        fn address(&self) -> Option<String> {
            new_private_address(&self.2, &addresses())
        }
        fn state(&self) -> Result<State, String> {
            let mut pending = self
                .1
                .lock()
                .map_err(|_| "Windows hotspot state unavailable")?;
            if let Some(status) = pending.as_ref() {
                if os(status())? {
                    return Ok(State::Busy);
                }
                *pending = None;
            }
            Ok(match os(self.0.TetheringOperationalState())? {
                TetheringOperationalState::Off => State::Off,
                TetheringOperationalState::On => State::On,
                _ => State::Busy,
            })
        }
        fn configuration(&self) -> Result<Configuration, String> {
            let config = os(self.0.GetCurrentAccessPointConfiguration())?;
            Ok(Configuration {
                ssid: os(config.Ssid())?.to_string(),
                password: os(config.Passphrase())?.to_string(),
                band: os(config.Band())?.0,
                authentication: config.AuthenticationKind().map(|kind| kind.0).unwrap_or(0),
            })
        }
        fn configure(&self, value: &Configuration) -> Result<(), String> {
            let config = os(NetworkOperatorTetheringAccessPointConfiguration::new())?;
            os(config.SetSsid(&HSTRING::from(&value.ssid)))?;
            os(config.SetPassphrase(&HSTRING::from(&value.password)))?;
            os(config.SetBand(TetheringWiFiBand(value.band)))?;
            // Older band-capable Windows releases support WPA2 only.
            if value.authentication != 0 {
                os(config
                    .SetAuthenticationKind(TetheringWiFiAuthenticationKind(value.authentication)))?;
            }
            let action = os(self.0.ConfigureAccessPointAsync(&config))?;
            let watched = action.clone();
            wait(
                &self.1,
                Box::new(move || watched.Status().map(|status| status.0 == 0)),
                || {
                    let _ = action.Cancel();
                },
            )?;
            os(action.GetResults())
        }
        fn supports_5ghz(&self) -> Result<bool, String> {
            let config = os(NetworkOperatorTetheringAccessPointConfiguration::new())?;
            let operation = os(config.IsBandSupportedAsync(TetheringWiFiBand::FiveGigahertz))?;
            let watched = operation.clone();
            wait(
                &self.1,
                Box::new(move || watched.Status().map(|status| status.0 == 0)),
                || {
                    let _ = operation.Cancel();
                },
            )?;
            os(operation.GetResults())
        }
        fn start(&self) -> Result<Started, String> {
            let operation = os(self.0.StartTetheringAsync())?;
            let watched = operation.clone();
            wait(
                &self.1,
                Box::new(move || watched.Status().map(|status| status.0 == 0)),
                || {
                    let _ = operation.Cancel();
                },
            )?;
            let result = os(operation.GetResults())?;
            match os(result.Status())? {
                TetheringOperationStatus::Success => Ok(Started::Ready),
                TetheringOperationStatus::BandInterference | TetheringOperationStatus::RadioRestriction => Ok(Started::BandUnavailable),
                _ => Err("Windows could not start Mobile hotspot. Check the sharing connection, Wi-Fi and system hotspot settings, then retry.".into()),
            }
        }
        fn stop(&self) -> Result<(), String> {
            let operation = os(self.0.StopTetheringAsync())?;
            let watched = operation.clone();
            wait(
                &self.1,
                Box::new(move || watched.Status().map(|status| status.0 == 0)),
                || {
                    let _ = operation.Cancel();
                },
            )?;
            if os(os(operation.GetResults())?.Status())? != TetheringOperationStatus::Success {
                return Err("Windows could not stop the hotspot. Turn it off in Mobile hotspot settings and retry.".into());
            }
            Ok(())
        }
    }
    pub(crate) struct Active(Host<Windows>);
    pub(crate) fn available() -> bool {
        let Ok(_runtime) = Runtime::enter() else {
            return false;
        };
        Windows::new().is_ok()
    }
    pub(crate) fn start(active: &mut Option<Active>) -> Result<Session, String> {
        let _runtime = Runtime::enter()?;
        if let Some(host) = active.as_ref() {
            if host.0.is_active()? {
                return Ok(host.0.session.clone());
            }
            host.0.stop()?;
            *active = None;
        }
        let mut random = [0u8; 16];
        unsafe { BCryptGenRandom(None, &mut random, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
            .ok()
            .map_err(|_| "Windows could not generate secure Wi-Fi credentials.")?;
        let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let host = Host::prepare(
            Windows::new()?,
            format!("PulseDrop-{}", &hex[..6]),
            hex[6..30].into(),
        )?;
        *active = Some(Active(host));
        let host = &mut active.as_mut().unwrap().0;
        if let Err(error) = host.activate() {
            // Keep the lease after uncertain/timeout failures, so Stop can
            // safely restore configuration instead of orphaning a live hotspot.
            if host.stop().is_ok() {
                *active = None;
            }
            return Err(error);
        }
        Ok(host.session.clone())
    }
    pub(crate) fn current(active: &mut Option<Active>) -> Result<Option<Session>, String> {
        let _runtime = Runtime::enter()?;
        if let Some(host) = active.as_mut() {
            if host.0.is_active()? {
                host.0.session.address = host.0.driver.address();
                return Ok(Some(host.0.session.clone()));
            }
            host.0.stop()?;
            *active = None;
        }
        Ok(None)
    }
    pub(crate) fn stop(active: &mut Option<Active>) -> Result<(), String> {
        let _runtime = Runtime::enter()?;
        if let Some(host) = active.as_ref() {
            host.0.stop()?;
        }
        *active = None;
        Ok(())
    }
}
#[cfg(target_os = "windows")]
pub(crate) use native::{available, current, start, stop, Active};

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Model {
        config: RefCell<Configuration>,
        state: RefCell<State>,
        five: bool,
        fail_five: bool,
        starts: RefCell<Vec<i32>>,
        changes: RefCell<usize>,
        fail_configuration_band: RefCell<Option<i32>>,
        fail_start: bool,
        stop_busy: bool,
    }
    impl Model {
        fn new(five: bool, fail_five: bool) -> Self {
            Self {
                config: RefCell::new(Configuration {
                    ssid: "My existing hotspot".into(),
                    password: "existing-password".into(),
                    band: 0,
                    authentication: 2,
                }),
                state: RefCell::new(State::Off),
                five,
                fail_five,
                starts: RefCell::new(vec![]),
                changes: RefCell::new(0),
                fail_configuration_band: RefCell::new(None),
                fail_start: false,
                stop_busy: false,
            }
        }
    }
    impl Driver for Model {
        fn configuration(&self) -> Result<Configuration, String> {
            Ok(self.config.borrow().clone())
        }
        fn configure(&self, config: &Configuration) -> Result<(), String> {
            *self.config.borrow_mut() = config.clone();
            *self.changes.borrow_mut() += 1;
            if *self.fail_configuration_band.borrow() == Some(config.band) {
                *self.fail_configuration_band.borrow_mut() = None;
                return Err("Configuration failed after applying".into());
            }
            Ok(())
        }
        fn state(&self) -> Result<State, String> {
            Ok(*self.state.borrow())
        }
        fn supports_5ghz(&self) -> Result<bool, String> {
            Ok(self.five)
        }
        fn start(&self) -> Result<Started, String> {
            let band = self.config.borrow().band;
            self.starts.borrow_mut().push(band);
            if self.fail_start {
                return Err("Permission denied".into());
            }
            if band == 2 && self.fail_five {
                return Ok(Started::BandUnavailable);
            }
            *self.state.borrow_mut() = State::On;
            Ok(Started::Ready)
        }
        fn stop(&self) -> Result<(), String> {
            *self.state.borrow_mut() = if self.stop_busy {
                State::Busy
            } else {
                State::Off
            };
            Ok(())
        }
    }
    #[test]
    fn windows_prefers_5ghz_and_restores_all_previous_settings() {
        let mut host = Host::prepare(
            Model::new(true, false),
            "PulseDrop-test".into(),
            "password123".into(),
        )
        .unwrap();
        host.activate().unwrap();
        assert_eq!(*host.driver.starts.borrow(), [2]);
        assert!(host
            .session
            .network_info
            .as_ref()
            .unwrap()
            .contains("5 GHz"));
        host.stop().unwrap();
        assert!(host.driver.configuration().unwrap() == host.previous);
    }
    #[test]
    fn windows_unsupported_or_failed_5ghz_uses_bounded_compatibility_attempt() {
        for (supported, fail, expected) in [(false, false, vec![1]), (true, true, vec![2, 1])] {
            let mut host = Host::prepare(
                Model::new(supported, fail),
                "PulseDrop-test".into(),
                "password123".into(),
            )
            .unwrap();
            host.activate().unwrap();
            assert_eq!(*host.driver.starts.borrow(), expected);
            assert!(host
                .session
                .network_info
                .as_ref()
                .unwrap()
                .contains("2.4 GHz"));
            host.stop().unwrap();
            assert!(host.driver.configuration().unwrap() == host.previous);
        }
    }
    #[test]
    fn windows_never_replaces_an_active_system_hotspot() {
        for state in [State::On, State::Busy] {
            let model = Model::new(true, false);
            *model.state.borrow_mut() = state;
            assert!(Host::prepare(model, "PulseDrop-test".into(), "password123".into()).is_err());
        }
    }
    #[test]
    fn windows_preserves_settings_changed_by_user_before_setup_or_stop() {
        let mut host = Host::prepare(
            Model::new(true, false),
            "PulseDrop-test".into(),
            "password123".into(),
        )
        .unwrap();
        host.driver.config.borrow_mut().ssid = "User selected".into();
        assert!(host.activate().is_err());
        assert_eq!(*host.driver.changes.borrow(), 0);
        host.driver.configure(&host.previous).unwrap();
        host.activate().unwrap();
        host.driver.config.borrow_mut().ssid = "User selected".into();
        let before = *host.driver.changes.borrow();
        host.stop().unwrap();
        assert_eq!(*host.driver.changes.borrow(), before);
        assert!(host.driver.state().unwrap() == State::On);
    }
    #[test]
    fn windows_busy_cleanup_retains_owned_configuration_for_retry() {
        let mut host = Host::prepare(
            Model::new(true, false),
            "PulseDrop-test".into(),
            "password123".into(),
        )
        .unwrap();
        host.activate().unwrap();
        *host.driver.state.borrow_mut() = State::Busy;
        assert!(host.stop().is_err());
        assert!(host.owns_configuration().unwrap());
        *host.driver.state.borrow_mut() = State::Off;
        host.stop().unwrap();
        assert!(host.driver.configuration().unwrap() == host.previous);
    }
    #[test]
    fn windows_partial_configuration_failures_restore_previous_settings() {
        for fail_band in [1, 2] {
            let mut host = Host::prepare(
                Model::new(true, true),
                "PulseDrop-test".into(),
                "password123".into(),
            )
            .unwrap();
            *host.driver.fail_configuration_band.borrow_mut() = Some(fail_band);
            assert!(host.activate().is_err());
            host.stop().unwrap();
            assert!(host.driver.configuration().unwrap() == host.previous);
            assert!(host.driver.state().unwrap() == State::Off);
        }
    }
    #[test]
    fn windows_permission_errors_fail_once_without_band_retries() {
        let mut model = Model::new(true, false);
        model.fail_start = true;
        let mut host = Host::prepare(model, "PulseDrop-test".into(), "password123".into()).unwrap();
        assert!(host.activate().unwrap_err().contains("Permission denied"));
        assert_eq!(*host.driver.starts.borrow(), [2]);
        host.stop().unwrap();
        assert!(host.driver.configuration().unwrap() == host.previous);
    }
    #[test]
    fn windows_stop_waits_for_off_before_releasing_ownership() {
        let mut model = Model::new(true, false);
        model.stop_busy = true;
        let mut host = Host::prepare(model, "PulseDrop-test".into(), "password123".into()).unwrap();
        host.activate().unwrap();
        assert!(host.stop().is_err());
        assert!(host.owns_configuration().unwrap());
        *host.driver.state.borrow_mut() = State::Off;
        host.stop().unwrap();
        assert!(host.driver.configuration().unwrap() == host.previous);
    }
    #[test]
    fn windows_host_address_requires_a_unique_new_private_interface_address() {
        use std::net::Ipv4Addr as Ip;
        let lan = Ip::new(192, 168, 1, 10);
        let hotspot = Ip::new(192, 168, 137, 1);
        assert_eq!(
            new_private_address(&[lan], &[lan, hotspot]).as_deref(),
            Some("192.168.137.1")
        );
        assert_eq!(new_private_address(&[lan], &[lan]), None);
        assert_eq!(
            new_private_address(&[lan], &[lan, hotspot, Ip::new(10, 2, 0, 1)]),
            None
        );
        assert_eq!(
            new_private_address(&[lan], &[Ip::LOCALHOST, Ip::new(169, 254, 1, 1)]),
            None
        );
    }
}
