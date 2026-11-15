# WordCraft integration under development

The parent owns composition; this maintained fork owns the actual WordCraft engine/UI, its host-save interface and this public mount entrypoint. Upstream native/CLI organization, history and licenses remain intact. The selected upstream baseline is preserved on `webos/integration`; functional work is on `webos/rebuild`. No publication or production deployment is authorized.

The current changes are not yet browser-qualified or selected by the parent. A successful WASM check is not an editor acceptance test. Twelve host-save tests and eighteen web/picker/layout engine tests pass, along with the required-input WASM check. Full browser artifact and actual editor acceptance are recorded separately in private migration evidence and remain in progress.

## Real save completion

The native `Services::host_save` hook now receives `HostSaveContext` with the exact document/revision/operation captured beside serialization. The browser emits the base host message `wordcraft:save` with `id`, plus explicit `documentId`, `revision` and `operation`. The host answers `wordcraft:saved {id}` only after durable storage confirmation. The explicit same-origin `wordcraft:save-failed {id,error}` extension ends a failed or uncertain save; silence times out without declaring success. The base bridge's origin/source checks remain in force. These are real engine/interface changes; a JS wrapper does not mark the document saved on posting bytes.

Pending saves keep dirty inspection and host notifications unsaved. Save As adopts its source name after successful acknowledgement; failure retains its original identity, and out-of-order replies cannot replace a later confirmed path. Copies/exports keep the source identity. Existing picker and synchronous embedding behavior remain separate paths with retained tests in the same engine.

The public `@webos/wordcraft` entrypoint mounts synchronously, with explicit readiness/failure/cancellation. Its async inspector reads the actual native command interface. Operations require exact instance, account-session, native document and resource identities, plus an authorized caller. Human controls and public commands use the same engine. The current parent human authority is not delegated agent authentication; that gate remains pending. Same-origin framing is a lifecycle boundary for trusted code, not a hostile-code sandbox.

## Complete browser assets

Provide a clean component checkout, Rust with its wasm32 target, pinned Trunk 0.21.14, and clean font/translation checkouts at the pins declared by upstream's release workflow and `craft-i18n.rev`:

```sh
python3 webos/build.py --output /absolute/new/public/site \
  --cache /absolute/private/build-cache \
  --fonts /absolute/pinned/craft-fonts \
  --translations /absolute/pinned/craft-i18n
```

Use separate `CARGO_HOME`/`RUSTUP_HOME` for a scoped toolchain when desired. This recipe installs no global tools, refuses unknown cache/output collisions, uses external build outputs, verifies all font payload hashes/notices and requires translations/fonts. It packages the complete Trunk WASM/JS graph, extracts the generated initializer unchanged into an external module for the assembly's CSP, includes notices, and records actual file sizes/digests, source/input commits, lockfile hash and tool versions. There is no assumed 1GiB suite or artifact budget in this recipe. Artifact construction, app installation policy, account-file limits, browser cache and resident memory are distinct requirements.

Browser proof must still cover actual typing, native programmatic edits and undo, saved bytes reopened in another clean context, stale saves, failed/uncertain saves, Save As/export identity, independent instances and lifecycle cleanup. Existing-user staging compatibility and full-suite qualification remain separate gates.

The default `development` profile builds the complete engine with Cargo's development profile and this integration HTML entrypoint. It skips the release-only Binaryen size-optimization pass, preserving codecs, UI, fonts and translations. Use `--profile release` for upstream's release HTML and optimized pipeline. The receipt identifies the actual profile; development/browser acceptance is not optimized-release qualification.
