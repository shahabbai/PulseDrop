# Receiving progress

The Receive screen shows live incoming bytes, percentage, and average speed. Each active file has a separate activity row. With simultaneous uploads the top card aggregates the active files' received and total bytes; it does not claim to know how many files remain in a sender's queue. Small files may complete before an intermediate update is visible.

## Events and completion

The native HTTP receiver emits `file-receive-progress` after authentication and parsing the declared content length. Updates contain `transfer_id`, `name`, `size`, `received`, `speed` (bytes per second), `phase` (`receiving`, `completed`, `failed`, or `cancelled`), and an optional `error`.

The stream emits an initial zero-byte update, throttled intermediate updates approximately every 120 ms, and an unthrottled terminal update. Received byte counts include body bytes already buffered while reading HTTP headers. Intermediate UI percentages stay below 100%; completion requires the entire body to be written and committed to the final Inbox path.

The existing `file-received` event remains, with an additional `transfer_id` for correlation. Its name, size, and path fields remain available. The frontend correlates both event types by ID, updates the same activity row, and increments its received-file count once. Late or duplicate updates cannot turn a completed transfer back into an active transfer. Event history is bounded while active uploads remain visible.

These are local Tauri UI events. Version 0.3.1 also adds optional transfer IDs and authenticated cancellation/status endpoints, retaining the existing health/upload bodies and pairing flow. An older sending app can still upload to an updated receiving app and trigger receiving progress. See [transfer cancellation](transfer-cancellation.md) for negotiation, queue behavior, and compatibility.

## Incomplete uploads

Incoming bytes are staged under the Inbox's `.pulsedrop-transfers` directory. A zero-length final-name reservation prevents simultaneous, same-named uploads from overwriting each other. The staged file replaces its reservation only after the complete body has been written and the file handle closed.

Android's existing storage mirror ignores directories and zero-length files, so it does not publish a paused, incomplete upload. Read/write failures and disconnects emit a failed progress update and remove that transfer's staging file and reservation. A successful file stays received even if the sender disconnects before reading its HTTP acknowledgement. Files left by a forcibly terminated app process are not automatically recovered by this change.

## Implementation and checks

- `src-tauri/src/receive.rs`: streaming, throttled events, staging, reservation, cleanup, and native unit tests.
- `src-tauri/src/lib.rs`: authenticated HTTP upload integration and existing completion event.
- `src/receive-progress.js`: progress normalization, concurrent totals, terminal-state handling, and deduplication.
- `src/main.js`, `src/index.html`, and `src/styles.css`: native-event listeners, incoming monitor, activity progressbars, and accessible phase announcements.
- `tests/receive-progress.test.mjs`: partial/terminal progress, duplicate completion, stale updates, same-named simultaneous transfers, and empty files.

Run `npm test`, build the frontend, and run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`. Native discovery tests require local UDP access. Then follow [device testing](device-testing.md) with a real PC-to-phone transfer. Linux WebView tests do not replace physical Android validation.

Local validation passed all 17 Rust tests, the JavaScript test suite, frontend and Linux native builds, and the Android debug build. A native Linux WebView test sent a file through the actual sender and HTTP receiver using a paced local relay. Both monitors advanced during transfer, navigating away preserved receiving progress, the saved bytes matched exactly, and completion produced one received row and count increment. Additional TCP uploads verified simultaneous same-named files, disconnect cleanup without false success, and empty files. The receive view also passed horizontal-overflow checks at desktop and narrow window sizes.

The rebuilt ARM64 debug APK passed APK v2 signature verification and ZIP/16 KB alignment checks. Its native library contains the new receiving-progress event and staging implementation. Physical Android validation remains the device-testing checklist.
