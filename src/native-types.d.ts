export type Theme = "light" | "dark";
export type Unlisten = () => void;
export type NetworkAddress = {
  ip: string;
  interface_name: string;
  label: string;
  is_private: boolean;
  is_vpn_like: boolean;
};
export type Receiver = {
  ip_address: string | null;
  ip_addresses: NetworkAddress[];
  port: number;
  code: string;
  inbox_dir: string;
  discovery_error: string | null;
};
export type Diagnostic = {
  status: string;
  title?: string;
  message: string;
  detail: string;
  can_fix: boolean;
};
export type Diagnostics = {
  is_windows: boolean;
  app_path: string;
  network: Diagnostic;
  firewall: Diagnostic;
};
export type ReceiveProgress = {
  transfer_id: string;
  name: string;
  size: number;
  received: number;
  speed: number;
  phase: "started" | "receiving" | "completed" | "failed" | "cancelled";
  error: string | null;
};
export type NativeEvents = {
  "file-receive-progress": ReceiveProgress;
  "file-received": { transfer_id?: string; name: string; size: number; path: string };
};
export type HotspotSession = {
  role: "host" | "sender";
  ssid: string;
  password: string;
  address: string | null;
  network_info?: string;
};
type Command<Args extends unknown[], Result> = { args: Args; result: Result };
type NativeCommands = {
  device_profile: Command<[], {
    name: string;
    platform: string;
    arch: string;
    primary_ip: string | null;
    network_ips: NetworkAddress[];
  }>;
  discover_receivers: Command<[], { id: string; name: string; ip: string; port: number; platform: string }[]>;
  start_receiver: Command<[{ receiverName: string | null }], Receiver>;
  stop_receiver: Command<[], void>;
  cancel_receive: Command<[{ transferId: string | null }], void>;
  open_inbox: Command<[], void>;
  windows_diagnostics: Command<[], Diagnostics>;
  fix_windows_network_profile: Command<[], string>;
  fix_windows_firewall: Command<[], string>;
  hotspot_capabilities: Command<[], { can_host: boolean; can_join: boolean; can_scan: boolean; platform: string; message: string }>;
  start_hotspot: Command<[], HotspotSession>;
  join_hotspot: Command<[{ ssid: string; password: string; bssid: string | null; interface: string | null }], HotspotSession>;
  stop_hotspot: Command<[], void>;
  hotspot_status: Command<[], HotspotSession | null>;
  scan_hotspots: Command<[], { ssid: string; security: string; signal: number; bssid: string; interface: string }[]>;
  open_wifi_settings: Command<[{ hosting: boolean }], void>;
  qr_camera_active: Command<[{ active: boolean }], void>;
};
export type Invoke = <K extends keyof NativeCommands>(command: K, ...args: NativeCommands[K]["args"]) => Promise<NativeCommands[K]["result"]>;
type Listen = <K extends keyof NativeEvents>(event: K, callback: (event: { payload: NativeEvents[K] }) => void) => Promise<Unlisten>;

interface AndroidBridge {
  deviceName?(): string;
  setDiscoveryActive?(active: boolean): void;
  setTheme?(theme: Theme): void;
  openInbox?(): void;
  hotspotStatus(): string;
  hotspotStart(): void;
  hotspotStop(): void;
  hotspotJoin(ssid: string, password: string, bssid: string): void;
  hotspotScan(): void;
  hotspotScanStatus(): string;
  hotspotScanStop(): void;
  openWifiSettings(hosting: boolean): void;
}

export interface NativePlatform {
  invoke?: Invoke;
  android: boolean;
  hotspotBridge?: AndroidBridge;
  deviceName(): string | null;
  setDiscoveryActive(active: boolean): void;
  openInbox(path: string): Promise<"downloads" | "manual" | undefined>;
  setTheme(theme: Theme): void;
  subscribeReceiver(onProgress: (progress: ReceiveProgress) => void, makeId: () => string): Unlisten;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: Invoke };
      event?: { listen?: Listen };
      opener?: { openPath?: (path: string) => Promise<void> };
      window?: { getCurrentWindow(): { setTheme(theme: Theme): Promise<void> } };
    };
    PulseDropAndroid?: AndroidBridge;
    PulseDropNative: NativePlatform;
    PulseDropTheme: { getTheme(): Theme; setTheme(theme: Theme): void };
  }
}
