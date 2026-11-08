//! Linux AP planning. Regulatory/channel restrictions come from the driver;
//! NetworkManager remains responsible for validating and activating each plan.
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Choice {
    pub band: &'static str,
    pub channel: u16,
    pub width: Option<u16>,
}

pub(super) const COMPATIBILITY: Choice = Choice {
    band: "bg",
    channel: 0,
    width: None,
};

// Optional, read-only tool. Missing iw must not prevent a compatibility hotspot.
pub(super) fn iw(args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("iw")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Wi-Fi radio details unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Wi-Fi radio details unavailable")?;
    let (tx, rx) = mpsc::channel();
    // Drain stdout concurrently: even a large capability dump cannot fill the
    // pipe and hang the app. Bound memory and the subprocess lifetime as well.
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(256 * 1024 + 1).read_to_end(&mut bytes);
        let _ = tx.send(result.map(|_| bytes));
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = rx
                    .recv_timeout(Duration::from_millis(100))
                    .map_err(|_| "Wi-Fi radio details unavailable")?
                    .map_err(|_| "Wi-Fi radio details unavailable")?;
                return if status.success() && bytes.len() <= 256 * 1024 {
                    Ok(String::from_utf8_lossy(&bytes).into_owned())
                } else {
                    Err("Wi-Fi radio details unavailable".into())
                };
            }
            Ok(None) if started.elapsed() < Duration::from_secs(3) => {
                thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Wi-Fi radio query timed out".into());
            }
        }
    }
}

pub(super) fn phy_name(info: &str) -> Option<String> {
    let number = info
        .lines()
        .find_map(|line| line.trim().strip_prefix("wiphy "))?;
    number
        .parse::<u32>()
        .ok()
        .map(|number| format!("phy{number}"))
}

pub(super) fn wide_channels_supported(version: &str) -> bool {
    version.split_whitespace().any(|word| {
        let mut parts = word.split('.');
        let major = parts.next().and_then(|s| s.parse::<u32>().ok());
        let minor = parts.next().and_then(|s| s.parse::<u32>().ok());
        matches!((major, minor), (Some(1), Some(50..)) | (Some(2..), Some(_)))
    })
}

pub(super) fn choices(phy: Option<&str>, wide_supported: bool) -> Vec<Choice> {
    let mut channels = Vec::new();
    let mut saw_frequency = false;
    let mut vht = false;
    if let Some(phy) = phy {
        for line in phy.lines().map(str::trim) {
            if line.starts_with("Band ") {
                vht = false;
            }
            if line.starts_with("VHT Capabilities") {
                vht = true;
            }
            let Some((frequency, rest)) =
                line.strip_prefix("* ").and_then(|s| s.split_once(" MHz ["))
            else {
                continue;
            };
            let Ok(frequency) = frequency.parse::<f64>() else {
                continue;
            };
            saw_frequency = true;
            if !(5000.0..5900.0).contains(&frequency) {
                continue;
            }
            let Some((channel, _)) = rest.split_once(']') else {
                continue;
            };
            let Ok(channel) = channel.parse::<u16>() else {
                continue;
            };
            let flags: String = rest
                .to_ascii_lowercase()
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '-')
                .collect();
            if ["disabled", "noir", "passivescan", "radar", "no20mhz"]
                .iter()
                .any(|flag| flags.contains(flag))
            {
                continue;
            }
            channels.push((
                channel,
                vht && !flags.contains("no80mhz") && !flags.contains("noht40"),
            ));
        }
    }
    channels.sort_unstable();
    channels.dedup();
    let mut result = Vec::new();
    let wide_channel = if wide_supported {
        // Common non-DFS 80 MHz blocks. All four constituent channels must be
        // permitted; never infer availability from just the primary channel.
        [36, 149]
            .into_iter()
            .find(|start| (0..4).all(|i| channels.contains(&(start + i * 4, true))))
    } else {
        None
    };
    if let Some(channel) = wide_channel {
        result.push(Choice {
            band: "a",
            channel,
            width: Some(80),
        });
    }
    if let Some(channel) = wide_channel.or_else(|| channels.first().map(|(channel, _)| *channel)) {
        result.push(Choice {
            band: "a",
            channel,
            width: None,
        });
    } else if !saw_frequency {
        // Without iw, ask NetworkManager to choose a legal 5 GHz channel itself.
        result.push(Choice {
            band: "a",
            channel: 0,
            width: None,
        });
    }
    result.push(COMPATIBILITY);
    result
}

pub(super) fn connection_description(info: &str) -> Option<String> {
    let line = info
        .lines()
        .find_map(|line| line.trim().strip_prefix("channel "))?;
    let channel = line.split_whitespace().next()?.parse::<u16>().ok()?;
    let frequency = line
        .split_once('(')?
        .1
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()?;
    let band = if (5000.0..5900.0).contains(&frequency) {
        "5 GHz"
    } else if (2400.0..2500.0).contains(&frequency) {
        "2.4 GHz"
    } else {
        return None;
    };
    let width = line
        .split_once("width:")
        .and_then(|(_, width)| width.split_whitespace().next()?.parse::<u16>().ok());
    Some(match width {
        Some(width) => format!("{band} · channel {channel} · {width} MHz."),
        None => format!("{band} · channel {channel}."),
    })
}

pub(super) fn description(info: Option<&str>, choice: Choice, fallback: bool) -> String {
    let observed = info
        .filter(|info| info.lines().any(|line| line.trim() == "type AP"))
        .and_then(connection_description);
    let mut description = observed.unwrap_or_else(|| {
        format!(
            "Configured for {}; actual channel details unavailable.",
            if choice.band == "a" {
                "5 GHz"
            } else {
                "2.4 GHz"
            }
        )
    });
    if choice.band == "bg" {
        description.push_str(if fallback { " 5 GHz setup was unavailable; compatibility settings were used." }
            else { " Compatibility settings were selected because no usable 5 GHz configuration was reported." });
    } else if fallback {
        description.push_str(
            " Wider-channel setup was unavailable; conservative 5 GHz settings were used.",
        );
    }
    description
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) const PHY: &str = "Band 1:\n * 2412 MHz [1] (20 dBm)\nBand 2:\n VHT Capabilities (0):\n * 5180 MHz [36] (23 dBm)\n * 5200 MHz [40] (23 dBm)\n * 5220 MHz [44] (23 dBm)\n * 5240 MHz [48] (23 dBm)\n * 5260 MHz [52] (radar detection)\n";

    #[test]
    fn selects_permitted_non_dfs_channels_and_preserves_compatibility() {
        assert_eq!(
            choices(Some(PHY), true),
            [
                Choice {
                    band: "a",
                    channel: 36,
                    width: Some(80)
                },
                Choice {
                    band: "a",
                    channel: 36,
                    width: None
                },
                COMPATIBILITY
            ]
        );
        assert_eq!(choices(Some(PHY), false).len(), 2);
        assert_eq!(
            choices(None, true),
            [
                Choice {
                    band: "a",
                    channel: 0,
                    width: None
                },
                COMPATIBILITY
            ]
        );
    }

    #[test]
    fn excludes_restricted_channels_and_does_not_widen_incomplete_blocks() {
        for restriction in [
            "disabled",
            "no IR",
            "radar detection",
            "passive scan",
            "no 20MHz",
        ] {
            let phy = PHY.replace(
                "5180 MHz [36] (23 dBm)",
                &format!("5180 MHz [36] ({restriction})"),
            );
            let selected = choices(Some(&phy), true);
            assert_eq!(
                selected[0],
                Choice {
                    band: "a",
                    channel: 40,
                    width: None
                }
            );
            assert!(selected.iter().all(|choice| choice.width.is_none()));
        }
        let phy = PHY.replace("5180 MHz [36] (23 dBm)", "5180 MHz [36] (no 80MHz)");
        assert_eq!(
            choices(Some(&phy), true)[0],
            Choice {
                band: "a",
                channel: 36,
                width: None
            }
        );
        assert_eq!(
            choices(
                Some("* 2412 MHz [1] (20 dBm)\n* 5180 MHz [36] (no IR)"),
                true
            ),
            [COMPATIBILITY]
        );
        assert_eq!(
            choices(
                Some(&PHY.replace("VHT Capabilities", "HT Capabilities")),
                true
            )[0]
            .width,
            None
        );
    }

    #[test]
    fn chooses_an_alternate_wide_block_when_the_lower_block_is_restricted() {
        let alternate = format!("{}\n* 5745 MHz [149] (23 dBm)\n* 5765 MHz [153] (23 dBm)\n* 5785 MHz [157] (23 dBm)\n* 5805 MHz [161] (23 dBm)", PHY.replace("5180 MHz [36] (23 dBm)", "5180 MHz [36] (no IR)"));
        assert_eq!(
            choices(Some(&alternate), true)[0],
            Choice {
                band: "a",
                channel: 149,
                width: Some(80)
            }
        );
    }

    #[test]
    fn parses_supported_networkmanager_versions_and_safe_phy_names() {
        for version in ["nmcli tool, version 1.50.0", "1.54.3", "2.0.1"] {
            assert!(wide_channels_supported(version));
        }
        for version in ["1.46.0", "1.9.8", "", "unknown"] {
            assert!(!wide_channels_supported(version));
        }
        assert_eq!(phy_name("Interface wlo1\n wiphy 2\n"), Some("phy2".into()));
        assert_eq!(phy_name("wiphy ../../other"), None);
    }

    #[test]
    fn reports_observed_radio_settings_and_honestly_handles_missing_details() {
        let choice = Choice {
            band: "a",
            channel: 36,
            width: Some(80),
        };
        assert_eq!(
            description(
                Some("type AP\nchannel 36 (5180 MHz), width: 80 MHz, center1: 5210 MHz"),
                choice,
                false
            ),
            "5 GHz · channel 36 · 80 MHz."
        );
        assert!(description(None, choice, false).contains("actual channel details unavailable"));
        assert!(description(
            Some("type AP\nchannel 6 (2437 MHz), width: 20 MHz"),
            COMPATIBILITY,
            true
        )
        .contains("2.4 GHz · channel 6 · 20 MHz."));
        assert!(description(
            Some("type managed\nchannel 36 (5180 MHz), width: 80 MHz"),
            choice,
            false
        )
        .starts_with("Configured"));
    }
}
