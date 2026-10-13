## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Checks run

- [ ] `npm run typecheck`
- [ ] `npm run lint` (no new errors or warnings)
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cargo clippy --all-targets -- -D warnings` and `cargo test`, in `src-tauri`
- [ ] `python -m pytest`

## Tested with

<!-- The Vivado version, the cable and the device you ran it with - or "no hardware".
     If a command that is sent to Vivado or xsct changed: the command before and after, for ordinary input. -->

## Privacy

- [ ] Nothing here names a private design: no probe file, capture, log or saved profile, and only invented
      names in examples and tests.
