# Transfer cancellation (0.3.1)

On Send, **Cancel transfer** stops receiver checking, Android file preparation, the active upload, and the rest of that send's queue. Already completed files stay saved. Queued files remain available for another send. On Receive, **Cancel** in a file's activity row stops only that incoming file, while **Cancel file / Cancel all incoming** in the monitor stops the currently active incoming uploads. The receiver stays online. Cancelling from the receiving device also stops the updated sender's remaining queue.

Cancellation is immediate and does not ask for confirmation: it only discards the incomplete transfer. Both views show a textual **Cancelled** state and preserve the last byte progress rather than showing false success or 100%. A cancelled file does not increment the received count. Buttons have visible labels, keyboard focus, and at least 44 px control height. Incoming activity rows retain their DOM nodes during progress updates so a focused Cancel button stays operable.

## Protocol and state

The existing `GET /health` body (`Ready`) and successful upload body (`Saved`) are retained. Responses expose `X-PulseDrop-Cancellation: 1` through CORS so updated senders can negotiate the control endpoints. New uploads pass an optional, unique `transfer_id` query value to `POST /upload`; receivers generate an ID when older senders omit it.

- `GET /transfer?code=...&transfer_id=...` returns `{ "phase": "receiving" | "completed" | "failed" | "cancelled" | null }`.
- `POST /cancel?code=...&transfer_id=...` requests cancellation and returns the terminal/current phase. Completed files remain completed.
- Both endpoints require the receiver's pairing code. IDs are bounded and cannot contain path separators.
- The local `cancel_receive` Tauri command accepts an optional `transferId`; omission cancels all active incoming transfers.
- A cancellation arriving before the upload creates a short-lived tombstone, preventing the delayed upload from starting. Reusing an active or terminal transfer ID is rejected.
- Updated senders poll status without overlapping requests. Upload errors also check the remote phase because socket closure can arrive before the next cancellation poll.
- Terminal registry entries are bounded and expire from their terminal time, while active transfers remain registered. Starting a new send generates new IDs.

Incoming cancellation shuts down the cloned TCP read half, waking a stalled reader without waiting for the normal upload timeout. The worker closes its file handle and removes its `.pulsedrop-transfers/*.part` file and zero-length name reservation before emitting the terminal progress event. Cancellation and final commit share a lock: cancellation accepted first prevents publication; commit accepted first preserves the completed file. Android's existing mirror never sees staged partial contents.

The `file-receive-progress` event adds the `cancelled` phase. Successful `file-received` events still occur only for committed files. Unrequested disconnects remain failures rather than being labelled as user cancellations.

## Compatibility

Update both devices to 0.3.1 for coordinated cancellation and consistent labels. Earlier receivers still accept the extra upload query parameter. If they do not advertise cancellation support, the new sender uses local XHR abort; older receivers may label the disconnected upload as failed. A new receiver can cancel an older sender's connection, but the older sender may report a connection error and continue its queue. There is no claim that an older app implements the new controls.

## Validation

Run `npm test`, `npm run frontend:build`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` (the network tests need local socket access). Native tests cover cancellation before start, during streaming, after the last byte, against commit, and while reads are blocked; registry tests cover early cancellation, duplicate IDs, scoped/all cancellation, bounded history, and ID validation. Frontend tests cover cancelled terminal-state handling and independent concurrent progress.

For device testing, install the updated app on both devices, send a file large enough to observe progress, and cancel once from each side. Confirm that the sender's next queued file does not start, no incomplete file is published, the receiver stays online, and a subsequent transfer succeeds. Repeat with simultaneous incoming files and cancel one at a time. Use [device testing](device-testing.md) for the platform setup. Linux WebView automation does not replace physical Android, Windows, or macOS testing.

Local validation passed 24 Rust tests, six frontend/version/release-note test files, workflow linting, and the Linux native build. A real Linux WebView acting as sender and receiver through a paced TCP relay verified sender and receiver button cancellation, keyboard activation and focus retention, cancellation during health checking, authenticated early cancellation, per-file/all cancellation with simultaneous uploads, exact-byte retry, completed-file preservation, and a delayed success-acknowledgement race. Older sender uploads and local cancellation with an older receiver's capability set also passed. The Receive view passed overflow checks at 360, 375, 960, and 1120 px widths, and mobile cancel controls met 44 px height. Android file-preparation tests cover early/mid-read cancellation, late callbacks, read failure, and successful cleanup. Mock GitHub CLI checks confirmed version-only notes for release creation and draft retry, refusal to modify published releases, and no publication after upload failure.
