# Known-Fix: broken pyexpat on homebrew python@3.14 (operator machine)

**Banked:** 2026-06-09 (aussie, system-health lane) from a ~6-min pm-CLI outage.
**Fix verified by:** Collie. **Recurs on:** every `brew upgrade python@3.14`.

---

## Symptom (how the watchdog/operator recognizes it)

`pip` / `pipx` (or any python@3.14 invocation that imports XML) dies with:

```
ImportError: dlopen(... pyexpat...): Symbol not found: _XML_SetAllocTrackerActivationThreshold
```

On this operator machine, this most visibly takes down a `pipx reinstall` of the pm CLI → **pm CLI goes down** until fixed.

## Root cause

Homebrew `python@3.14` bottles (seen 3.14.3 → 3.14.5) ship a **broken `pyexpat.so`**: it hardcodes the OLD system `/usr/lib/libexpat`, which is MISSING the symbol `_XML_SetAllocTrackerActivationThreshold`. Homebrew's `expat 2.8.1` HAS that symbol — `pyexpat.so` just isn't linked against it.

## Known fix (~2 min)

`install_name_tool`-relink `pyexpat.so` to point at homebrew `expat 2.8.1` inside the `python@3.14` Cellar, then re-sign:

```bash
# Locate the broken pyexpat.so belonging to the ACTIVE python3.14 (the interpreter
# pipx uses). Do NOT `find $(brew --cellar python@3.14) | head -1` — if brew has
# retained more than one python@3.14 keg after an upgrade, that can pick a STALE
# inactive keg's pyexpat.so, relink the wrong one, and leave the active interpreter
# still broken. Derive the active interpreter's lib-dynload dir via sysconfig
# (does NOT import pyexpat, so it works even while pyexpat is broken):
PYDYNLOAD=$(python3.14 -c 'import sysconfig; print(sysconfig.get_config_var("DESTSHARED"))')
PYEXPAT=$(find "$PYDYNLOAD" -name 'pyexpat*.so' | head -1)
EXPAT_LIB="$(brew --prefix expat)/lib/libexpat.1.dylib"   # homebrew expat 2.8.1

# 1. See current (broken) libexpat link:
otool -L "$PYEXPAT" | grep -i expat
# 2. Relink to homebrew expat (replace the old /usr/lib/libexpat path with the homebrew one):
install_name_tool -change /usr/lib/libexpat.1.dylib "$EXPAT_LIB" "$PYEXPAT"
# 3. Re-sign (ad-hoc) so macOS accepts the modified binary:
codesign --force --sign - "$PYEXPAT"
# 4. Verify:
python3.14 -c "import pyexpat; print('pyexpat OK')"
```

(Confirm the exact old install-name from step 1's `otool -L` output and use it verbatim in step 2.)

## Fragility (why it recurs)

The next `brew upgrade python@3.14` **re-pours the broken bottle** and re-breaks `pyexpat`. Recovery = re-run the relink+resign above. It is NOT a one-time fix; it is a known-recurring 2-min repair keyed to python@3.14 upgrades.

## Broader lesson — pipx reinstall on a LIVE operator machine = env-ABI risk

A `pipx reinstall` on the operator machine can pick up a freshly-upgraded, ABI-broken interpreter and take down a live tool (here, the pm CLI). **Before running a reinstall on the live machine, stage a restore/rollback path** (note the current working interpreter/venv, or be ready to relink) so a bad bottle is a 2-min recovery, not an outage of unknown length. Pair with: hold downstream reinstalls (e.g. don't push the new pm-CLI version to Blue) until the operator-machine reinstall is confirmed healthy.

## Watchdog hook

If system-health monitoring sees `pip`/`pipx`/python@3.14 failing with `pyexpat` `Symbol not found`, this is the known-fix — go straight to the relink+resign, don't cold-rediscover.
