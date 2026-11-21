"""Exercise PulseDrop in its Linux WebView with an isolated data directory."""
import argparse
from contextlib import suppress
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from uuid import uuid4
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
DISCOVERY_PORT = 53613
ELEMENT_ID = "element-6066-11e4-a52e-4f735466cecf"


def wait_for(description, predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"Timed out waiting for {description}")


def unused_ports():
    with socket.socket() as first, socket.socket() as second:
        first.bind(("127.0.0.1", 0))
        second.bind(("127.0.0.1", 0))
        return first.getsockname()[1], second.getsockname()[1]


class WebView:
    def __init__(self, port, binary):
        self.base = f"http://127.0.0.1:{port}/"
        result = self.call("session", {"capabilities": {"alwaysMatch": {
            "tauri:options": {"application": str(binary)}
        }}})
        self.base += f"session/{result['sessionId']}/"

    def call(self, path, data=None, method="POST"):
        payload = json.dumps(data).encode() if data is not None else None
        request = Request(self.base + path, data=payload, method=method,
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=45) as response:
            return json.load(response)["value"]

    def script(self, source, *args):
        return self.call("execute/sync", {"script": source, "args": args})

    def click(self, selector):
        self.script("document.querySelector(arguments[0]).click()", selector)

    def nav(self, name):
        self.click(f'.nav-item[data-mode="{name}"]')
        assert self.script("return document.activeElement.id") == f"{name}-title"

    def text(self, selector):
        return self.script("return document.querySelector(arguments[0]).textContent", selector)

    def file(self, path):
        element = self.call("element", {"using": "css selector", "value": "#file-input"})[ELEMENT_ID]
        self.call(f"element/{element}/value", {"text": str(path)})

    def fill(self, selector, value):
        self.script("""
          const field = document.querySelector(arguments[0]);
          field.value = String(arguments[1]);
          field.dispatchEvent(new Event("input", { bubbles: true }));
        """, selector, value)


def wait_for_driver(process, port):
    def ready():
        if process.poll() is not None:
            raise RuntimeError("tauri-driver exited before WebDriver was ready")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return True
        except OSError:
            return False

    wait_for("WebDriver startup", ready)


def check_theme(app):
    app.nav("settings")
    for theme in ("light", "dark"):
        app.script("""
          const field = document.querySelector("#theme-select");
          field.value = arguments[0];
          field.dispatchEvent(new Event("change", { bubbles: true }));
        """, theme)
        assert app.script("return getComputedStyle(document.documentElement).colorScheme") == theme
        app.call("refresh", {})
        wait_for("app startup after refresh", lambda: app.script("return !document.querySelector('#boot-screen')"))
        assert app.script("return document.querySelector('#theme-select').value") == theme
    print("PASS theme changes and settings persistence", flush=True)


def check_discovery(app):
    # The Rust scanner ignores its own receiver. Simulate a nearby peer's reply
    # while letting the app send and validate its real UDP discovery packets.
    stop = threading.Event()
    peer_id = uuid4().hex
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as service:
        service.bind(("0.0.0.0", DISCOVERY_PORT))
        service.settimeout(0.2)

        def respond():
            while not stop.is_set():
                try:
                    packet, address = service.recvfrom(2048)
                    query = json.loads(packet)
                except (socket.timeout, ValueError):
                    continue
                if isinstance(query, dict) and query.get("service") == "pulsedrop" and query.get("kind") == "discover":
                    query.update(kind="receiver", receiver={
                        "id": peer_id, "name": "Smoke test receiver",
                        "platform": "linux", "port": 53612
                    })
                    service.sendto(json.dumps(query).encode(), address)

        thread = threading.Thread(target=respond, daemon=True)
        thread.start()
        try:
            app.nav("send")
            wait_for("the nearby receiver", lambda: "Smoke test receiver" in app.text("#receiver-list"))
            app.click(".receiver-choice")
            assert app.script("return document.activeElement.id") == "peer-code"
            assert app.script("return document.querySelector('#peer-port').value") == "53612"
        finally:
            stop.set()
            thread.join(timeout=2)
    print("PASS LAN discovery, receiver selection, and pairing-field focus", flush=True)


def check_update_notice(app):
    app.nav("home")
    app.script("""
      const updates = window.PulseDropNative.updates;
      const originalCheck = updates.check;
      const originalNow = Date.now;
      updates.check = async () => "0.9.0";
      Date.now = () => originalNow() + 7_200_000;
      window.restoreUpdateCheck = () => {
        updates.check = originalCheck;
        Date.now = originalNow;
      };
    """)
    try:
        wait_for("in-app update notice", lambda: app.script("""
          window.dispatchEvent(new Event("online"));
          return !document.querySelector("#update-notice").hidden;
        """))
        assert "0.9.0" in app.text("#update-notice-text")
        app.click("#view-update")
        assert app.script("return document.activeElement.id") == "check-update"
        assert app.text("#check-update") == "Install update"
        app.nav("home")
        app.click("#dismiss-update")
        assert app.script("return document.querySelector('#update-notice').hidden")
        assert app.script("return localStorage.getItem('pulsedrop.dismissedUpdateVersion')") == "0.9.0"
    finally:
        app.script("window.restoreUpdateCheck(); delete window.restoreUpdateCheck;")
    print("PASS automatic update notice, Settings navigation, and dismissal", flush=True)


def check_update_guard(app):
    app.nav("receive")
    app.click("#toggle-receiver")
    wait_for("receiver to start", lambda: app.text("#receiver-state") == "Online")
    app.nav("settings")
    app.click("#check-update")
    assert "Stop receiving" in app.text("#update-status")
    assert app.script("return document.querySelector('#update-progress').hidden")
    assert app.script("return !document.querySelector('#check-update').disabled")
    app.nav("receive")
    app.click("#toggle-receiver")
    wait_for("receiver to stop", lambda: app.text("#receiver-state") == "Offline")
    print("PASS update control blocks checks while the receiver is online", flush=True)


def check_transfers(app, directory):
    app.nav("receive")
    app.click("#toggle-receiver")
    wait_for("the receiver to come online", lambda: app.text("#receiver-state") == "Online")
    port = int(app.text("#session-port"))
    code = app.text("#session-code")
    inbox = Path(app.text("#inbox-path"))
    assert inbox.is_relative_to(directory), "Expected an isolated test inbox"

    file = directory / "webview-smoke.txt"
    body = b"PulseDrop native WebView transfer check\n"
    file.write_bytes(body)
    app.nav("send")
    app.file(file)
    wait_for("a file in the queue", lambda: app.text("#queue-count") == "1")
    app.fill("#peer-ip", "127.0.0.1")
    app.fill("#peer-port", port)
    app.fill("#peer-code", code)
    app.click("#send-files")
    wait_for("an acknowledged transfer", lambda: app.text("#transfer-name") == "Transfer complete")
    assert (inbox / file.name).read_bytes() == body

    app.nav("receive")
    wait_for("the receiver completion event", lambda: app.text("#inbox-count") == "1 file")
    name = "cancelled-smoke.bin"
    transfer_id = "webview-smoke-cancel"
    query = urlencode({"code": code, "name": name, "transfer_id": transfer_id})
    with socket.create_connection(("127.0.0.1", port), timeout=5) as stream:
        stream.sendall((
            f"POST /upload?{query} HTTP/1.1\r\nHost: localhost\r\n"
            "Content-Length: 65536\r\nConnection: close\r\n\r\n"
        ).encode() + b"x" * 4096)
        selector = f'[data-transfer-id="{transfer_id}"] .cancel-action'
        wait_for("a cancellable incoming file", lambda: app.script("""
          const action = document.querySelector(arguments[0]);
          return action && !action.hidden && !action.disabled;
        """, selector))
        app.click(selector)
        with stream.makefile("rb") as response:
            assert response.readline().startswith(b"HTTP/1.1 409")
    wait_for("incoming cancellation to settle", lambda: app.script(
        "return !!document.querySelector('.activity-row.cancelled')"))
    assert not (inbox / name).exists()
    assert app.text("#inbox-count") == "1 file"
    app.click("#toggle-receiver")
    wait_for("receiver to stop", lambda: app.text("#receiver-state") == "Offline")
    print("PASS native file selection, exact-byte transfer, progress events, and cancellation", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "src-tauri/target/release/pulse_drop")
    parser.add_argument("--native-driver", default=shutil.which("WebKitWebDriver"))
    args = parser.parse_args()
    if not args.binary.is_file() or not args.native_driver or not shutil.which("tauri-driver"):
        parser.error("Build the Linux app and put tauri-driver and WebKitWebDriver on PATH first.")

    port, native_port = unused_ports()
    with tempfile.TemporaryDirectory(prefix="pulsedrop-webview-") as temporary:
        folder = Path(temporary)
        env = os.environ.copy()
        for category in ("DATA", "CONFIG", "CACHE"):
            env[f"XDG_{category}_HOME"] = str(folder / category.lower())
        with (folder / "driver.log").open("w+") as log:
            process = subprocess.Popen([
                "tauri-driver", "--port", str(port), "--native-port", str(native_port),
                "--native-driver", args.native_driver
            ], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            app = None
            try:
                wait_for_driver(process, port)
                app = WebView(port, args.binary.resolve())
                wait_for("app startup", lambda: app.script("return !document.querySelector('#boot-screen')"))
                check_theme(app)
                check_update_notice(app)
                check_update_guard(app)
                check_discovery(app)
                check_transfers(app, folder)
            except Exception:
                log.seek(0)
                print(log.read(), flush=True)
                raise
            finally:
                if app:
                    try:
                        app.call("", method="DELETE")
                    except OSError:
                        pass
                # Stop the driver and its WebKit/app children before deleting
                # their temporary profile directory.
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    main()
