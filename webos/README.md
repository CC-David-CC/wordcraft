# WordCraft integration under development

The parent owns composition; this maintained fork owns the actual WordCraft engine/UI, its host-save interface and this public mount entrypoint. Upstream native/CLI organization, history and licenses remain intact. Upstream-tracking `main` is separate from the maintained `webos/...` branches. The parent pins an accepted component commit; publication and deployment are separately authorized parent operations.

The parent assembly records qualification of its exact selected component commit and artifact. Later fork changes require a new source-pinned artifact and browser checks; earlier hosted results do not qualify them automatically. Full browser qualification and whole-suite status belong to the parent assembly and deployment record.

## Save As Browse and export qualification

Hosted File › Save As › Browse dispatches the same account-owned command as F12.
The host asks for a relative account path including the filename; cancellation
changes no file or document identity, and only the server acknowledgement adopts
the destination. The standalone desktop/browser file-dialog route is unchanged.
Native tests click Browse itself and each of the thirteen export buttons. The
parent records the exact rebuilt WASM and account-delivery qualification.

Export writers for DOCX, the two XML dialects, ODT/OTT/FODT and RTF currently use
Save As semantics: a confirmed write changes the active document identity and
clears the saved revision. PDF, PNG, HTML, Markdown, LaTeX and text remain copies.
Export menu naming still uses the standalone suggested-name route. These are
known separate integration gaps; file generation is not a full-fidelity guarantee.

## Document-host contract under qualification

The current document behavior changes are source implementation in progress.
Native host, recovery/import and adapter tests have passed. The new WASM artifact and
assembled browser workflows are not yet qualified. Do not infer
a release from the interfaces documented here.

The mount remains synchronous. `ready` reports the first asynchronous opening
attempt; a failed account read retains the intended path, an inert editor and a
Retry control in the same view. `inspect()` separates `requestedPath` / `loadError`
from the confirmed `path` / `revision` / `loaded` binding. A successful Retry makes
the command interface usable even if the original readiness promise rejected.

The native engine opts into host-owned document windows with `documentHost=1`.
Versioned inspection (`hostDocumentVersion:1`, `hostOwnsDocuments:true`) and native
`wordcraft:document-state` events report document IDs, exact native revisions,
dirty state and pending saves. Interactive New/Open/Close and Save As without a
path emit `wordcraft:document-request`; the parent supplies account Open, new or
imported document windows, and close coordination. An existing account document
is activated through the same parent route from Files and WordCraft Open. The
current buffer is not replaced. Duplicate-view New Window is hidden/refused.

`fileBinding.snapshot()` / `subscribe()` expose only document identity, confirmed
account-relative path, saved server SHA-256 and loading state. The Desktop uses
those notifications for its caption and persisted layout. The native revision
identifies an in-memory editing state; the server SHA-256 identifies saved bytes.
They are distinct values. Neither a filename nor the native revision authorizes
an account write.

`wordcraft:save` also carries the requested path. A document save receives
`wordcraft:save-result {id,path}` only after Storage confirms its write. Native
save settlement adopts that canonical path and updates Recent. Exports retain
the base `wordcraft:saved {id}` acknowledgement and do not rebind the document.
Failure preserves the source identity; newer edits remain dirty after a delayed
successful save. Observer failure cannot change the outcome of a confirmed write.

`lifecycle.snapshot()` / `subscribe()` provide a monotonic host revision and
synchronous dirty/pending state. `quiesce()` pauses the actual native editor under
a matching document/revision lease (`ui.hostPause`); release must match the lease.
Close confirmation is checked again under that pause before recovery is cleared.
This does not treat closing an arbitrary view as authority to destroy a shared
service or job.

Recovery uses `document.recoverySnapshot` / `document.restoreSnapshot` on the
native model, including styles, lists and embedded media. The host supplies a
versioned snapshot, the unchanged clean target revision and optional canonical
relative `sourcePath`. Restore is always unsaved. Password-protected documents
refuse plaintext checkpoints. Device imports explicitly use `file.open` with
`unsaved:true`, retain no saved source and require an account save destination.

The app-owned recovery codec stores an opaque rich snapshot plus its confirmed
base path/hash. Runtime owns the ordered IndexedDB journal, scoped to issuer and
account, with fresh writer identities and generation-checked source removal.
Checkpoint requests coalesce while storage is busy; continuous typing schedules
one within five seconds rather than postponing it indefinitely. The interval is
a scheduling bound, not a durability promise: the native response and storage
transaction must succeed. A binding changed during capture forces recapture.
Changed/unverifiable server bases require Save As. The UI reports checkpoint
failure while preserving ordinary account Save. Recovery covers the last
successful local checkpoint, not storage eviction or zero-loss power failure.

The validated public `hostProfile` scopes native preferences/recent filenames
and uploaded-font loading, storage and deletion to an account. Missing or invalid
hosted profiles never fall back to unscoped stores. Existing unscoped data is
retained without guessing ownership. These namespaces prevent accidental
cross-account reuse; same-origin trusted code can still access origin storage.

The maintained UI removes Discord controls from File, the title bar and Help
ribbon, retaining the link in About. This is a requested fork customization,
independent of the platform integration contract.

## Real save completion

The native `Services::host_save` hook now receives `HostSaveContext` with the exact document/revision/operation captured beside serialization. The browser emits the base host message `wordcraft:save` with `id`, plus explicit `documentId`, `revision` and `operation`. A document-window host answers `wordcraft:save-result {id,path}` only after durable storage confirmation, returning the canonical source path. Exports and legacy hosts retain the compatible `wordcraft:saved {id}` acknowledgement. The explicit same-origin `wordcraft:save-failed {id,error}` extension ends a failed or uncertain save; silence times out without declaring success. The base bridge's origin/source checks remain in force. These are real engine/interface changes; a JS wrapper does not mark the document saved on posting bytes.

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

The document-host `cargo xtask ci` run with Rust/Clippy1.95 passes all nine
stages: formatting, full native Clippy, workspace tests, interface audit, language,
doctests, assets, layering and the14-crate WASM target check. The engine suite
passes1468 tests and the UI suite1264, with the existing ignored cases retained.
The full run caught an introduced protected-comment Save regression; it was
corrected without removing the original test, and a programmatic Save regression
also checks retained-draft host protection. The WASM target check retains two
warnings in unchanged native source. No lint threshold or assertion was lowered.

A fresh complete browser artifact and actual-engine browser acceptance remain
required. The target check does not compile or qualify every browser-only bridge
path, and native results alone do not establish deployed behavior.

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

## Design contrast and available fonts follow-up

The maintained fork is qualifying a native Shaded-style contrast correction and
available-font choices. Home and Design font menus use the native database's
available families, including fonts uploaded for the current account. Unavailable
recent suggestions are hidden without deleting their history. Existing document
font requests stay visible in the current-font field with their substitution
warning; removing a menu choice does not rewrite a document's formatting.

Source Sans 3, Source Serif 4, Inter and JetBrains Mono are embedded under their
OFL licenses. The browser build includes their actual notices as well as the
pinned craft-fonts notices. No proprietary font is added by this follow-up.
Parent release evidence qualifies an exact source commit and artifact; this
follow-up does not inherit the previous milestone's native/browser results.

## Account defaults for new blank documents

In the WebOS document host, Design → Set as Default captures a versioned native
formatting record and saves it through the existing authenticated account-file
capability to `Digital-Projects/WordCraft/defaults-v1.json`. This stores style
definitions, document default character/paragraph formatting, theme fonts and
theme colors. It does not store body text, headers, comments, sections, account
credentials or document save identity; tracked style-edit history is excluded.

Blank New loads the current account's record before creating the native document.
Explicit sample/letter/resume/report templates, file Open, imports and draft
recovery retain their own formatting. Loading or saving defaults does not mark the
current document saved, rewrite its formatting or change its file binding.
Native `design.defaultSnapshot`, `design.validateDefaults` and `design.loadDefaults`
share the same bounded schema as the headless engine's session-local Set as Default.
The host acknowledges durable success only after Storage confirms a revision.
Concurrent changes use compare-and-swap; failures and uncertain results remain
visible. Missing settings use built-ins; corrupt or unavailable settings block
blank creation with Retry rather than silently selecting another account's data.
There is no browser-global or guessed-account fallback. A fresh browser retrieves
the server record after signing in; uploaded font bytes still have their separate
account-scoped browser store and are not copied into the defaults record.

The record is capped at 256 KiB and 512 styles. Existing source and artifact
qualification remain separate; the parent release report records actual acceptance.

## Output completion and browser print (under qualification)

The host footer keeps account-save and local-recovery messages on one line, with
ellipsis for narrow windows and complete hover text. These remain distinct states.

Native asynchronous save/export tickets retain their originating document and
Backstage page. Only successful delivery returns that page to the document and
restores editor focus; cancellation, failure, another document or another page
cannot be dismissed by a late reply. A synchronous embedding uses its successful
callback as the delivery boundary. Save As paths still adopt only on durable host
acknowledgement, and exports neither rebind the source nor clear unsaved edits.

`file.printPdf` now hands the engine's selected-page/copy/imposition PDF bytes to
the same host storage path as other exports. The wasm engine's filesystem-free
file command alone cannot persist a PDF. Hosts must accept this explicit operation
in their save protocol; it remains an export with no document binding change.

The browser uses optional `Services::print_async` to load its PDF frame and report
actual `print()` invocation or failure through the existing print-state receiver.
Pending requests cannot replace the active PDF. A blocked/failed/timed-out frame
stays on Print with its error; success returns to the printed document if it is
still shown. Browser acceptance never means a physical print job succeeded: the
browser owns printer selection and cancellation. The last PDF frame is replaced
on the next print, and a timed-out frame cannot print later.

The embedding server must permit `blob:` frames on the WordCraft HTML response.
The WebOS deployment scopes that exception to `/wordcraft/index.html`, retaining
`object-src 'none'` and the existing desktop/other-app CSP. Do not disable CSP or
open arbitrary script/object/frame origins to get printing working.
