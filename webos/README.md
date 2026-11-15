# WordCraft integration under development

The parent owns composition; this maintained fork owns the actual WordCraft engine/UI, its host-save interface and this public mount entrypoint. Upstream native/CLI organization, history and licenses remain intact. The selected upstream baseline is preserved on `webos/integration`; functional work is on `webos/rebuild`. No publication or production deployment is authorized.

The parent assembly records qualification of its exact selected component commit and artifact. Later fork changes require a new source-pinned artifact and browser checks; earlier hosted results do not qualify them automatically. Full browser qualification and whole-suite status belong to the parent assembly and deployment record.

## Real save completion

The native `Services::host_save` hook now receives `HostSaveContext` with the exact document/revision/operation captured beside serialization. The browser emits the base host message `wordcraft:save` with `id`, plus explicit `documentId`, `revision` and `operation`. The host answers `wordcraft:saved {id}` only after durable storage confirmation. The explicit same-origin `wordcraft:save-failed {id,error}` extension ends a failed or uncertain save; silence times out without declaring success. The base bridge's origin/source checks remain in force. These are real engine/interface changes; a JS wrapper does not mark the document saved on posting bytes.

Pending saves keep dirty inspection and host notifications unsaved. Save As adopts its source name after successful acknowledgement; failure retains its original identity, and out-of-order replies cannot replace a later confirmed path. Copies/exports keep the source identity. Existing picker and synchronous embedding behavior remain separate paths with retained tests in the same engine.

The public `@webos/wordcraft` entrypoint mounts synchronously, with explicit readiness/failure/cancellation. Its async inspector reads the actual native command interface. Operations require exact instance, account-session, native document and resource identities, plus an authorized caller. Human controls and public commands use the same engine. The current parent human authority is not delegated agent authentication; that gate remains pending. Same-origin framing is a lifecycle boundary for trusted code, not a hostile-code sandbox.

`view.execute(request, callerCapability)` requires an explicit capability; omission
never substitutes the human capability retained by the view. The bounded JSON
request is captured before readiness or authorization waits. Authorization and
engine dispatch use that same command, target and argument snapshot. A resource
rebound by Save As while authorization waits invalidates the pending target.
The close dialog passes its human capability explicitly through the same command
entrypoint and still waits for durable storage confirmation.

Run the dependency-free host-boundary regression tests with Node24:

```sh
node --experimental-vm-modules --test webos/tests/view_authorization.test.mjs
```

These tests load the real mount module with a synthetic DOM/engine. They cover
caller/target refusal, command capture during async authorization, per-operation
policy, resource rebinding, disposal and human close-save. They do not qualify
native document fidelity, server delegation, or an agent transport.

The required `cargo xtask ci` attempt with Rust/Clippy1.95 passed formatting,
then stopped on three `nonminimal_bool` diagnostics in unchanged native source:
`crates/engine/src/cmd/insert/items.rs` and
`crates/engine/src/cmd/page/fit_page.rs`. Later CI steps did not run. These are
retained baseline findings, not a full CI pass; this host change does not lower
the lint threshold or modify the native expressions to hide that result.

## Complete browser assets

Provide a clean component checkout, Rust with its wasm32 target, pinned Trunk 0.21.14, and clean font/translation checkouts at the pins declared by `webos/craft-fonts.rev` and `craft-i18n.rev`:

```sh
python3 webos/build.py --output /absolute/new/public/site \
  --cache /absolute/private/build-cache \
  --fonts /absolute/pinned/craft-fonts \
  --translations /absolute/pinned/craft-i18n \
  --egui-origin /absolute/local/bare/egui.git \
  --craft-libs-origin /absolute/local/bare/craft-libs.git
```

Use separate `CARGO_HOME`/`RUSTUP_HOME` for a scoped toolchain when desired. This recipe installs no global tools, refuses unknown cache/output collisions, uses external build outputs, verifies all font payload hashes/notices and requires translations/fonts. It packages the complete Trunk WASM/JS graph, extracts the generated initializer unchanged into an external module for the assembly's CSP, includes notices, and records actual file sizes/digests, source/input commits, lockfile hash and tool versions. There is no assumed 1GiB suite or artifact budget in this recipe. Artifact construction, app installation policy, account-file limits, browser cache and resident memory are distinct requirements.

Browser proof must still cover actual typing, native programmatic edits and undo, saved bytes reopened in another clean context, stale saves, failed/uncertain saves, Save As/export identity, independent instances and lifecycle cleanup. Existing-user staging compatibility and full-suite qualification remain separate gates.

The default `development` profile builds the complete engine with Cargo's development profile and this integration HTML entrypoint. It skips the release-only Binaryen size-optimization pass, preserving codecs, UI, fonts and translations. Use `--profile release` for upstream's release HTML and optimized pipeline. The receipt identifies the actual profile; development/browser acceptance is not optimized-release qualification.

The maintained renderer revision is pinned in the root Cargo manifest and lock.
Supply `--egui-origin /absolute/local/bare/egui.git` to `build.py`. The provider
must contain that exact commit. The recipe scopes Cargo's Git transport to this
provider for this command only; it preserves the canonical upstream identity
and never edits global Git/SSH configuration or guesses a private server.
Native Cargo builds use the same maintained revision and can use the environment
returned by `scoped_egui_environment` to populate their dependency cache.
The artifact receipt records the egui revision, not a private provider path.


The WebOS font pin selects the maintained shared font repository independently
of upstream release workflow configuration. Its STIX Two Math face is embedded
in native and browser builds, so equation glyphs and OpenType MATH layout do not
require an installed system math font. The upstream font bytes, license and
provenance live in craft-fonts. The normal asset receipt includes its notice.

The craft-libs provider must contain every revision selected from that source,
including the maintained craft-update fix. Both provider mappings are scoped to
the build subprocess; canonical public URLs and exact revisions stay in Cargo.
