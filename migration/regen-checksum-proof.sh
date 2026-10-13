#!/usr/bin/env bash
# Regenerate the P02-QA-002 evidence: the enforced export-integrity check,
# proven to have teeth by two negative controls.
#
#   1. real ZIP + real expectation        -> PASS, exit 0
#   2. real ZIP + tampered expectation    -> per-file DIFF, exit 1
#   3. tampered ZIP + real expectation    -> zip-hash FAIL, exit 1
#
# Output is captured to a file first, then filtered, so every exit code recorded
# is the real Node exit and never a grep exit. No file contents are ever printed.
set -uo pipefail
cd "$(dirname "$0")/.."

V=migration/verify-checksums.mts
E=../docs/phases/phase-02/phase02-audit/verify-checksums-proof.txt
ZIP="C:/Users/Kingsley/AppData/Local/Temp/opencode/convex-prod-export/snapshot_gallant-loris-180_1790663640323327415.zip"
EXP=../docs/phases/phase-02/phase02-audit/export-checksums.txt
T=$(mktemp -d)

filter() { grep -v -e MODULE_TYPELESS -e Reparsing -e 'eliminate this' -e 'add "type"' -e 'trace-warnings' "$1"; }

{
  printf '##############################################################################\n'
  printf '# P02-QA-002 — enforced export integrity check, with negative controls\n'
  printf '#\n'
  printf '# A check nobody has seen fail is not a check. Runs 2 and 3 tamper with the\n'
  printf '# inputs and MUST exit non-zero; run 1 is the real pass.\n'
  printf '#\n'
  printf '# Command:\n'
  printf '#   node --experimental-strip-types migration/verify-checksums.mts [zip] [expected]\n'
  printf '# Never prints file contents — hashes and counts only.\n'
  printf '##############################################################################\n'
} > "$E"

# ── Run 1: the real pass ──────────────────────────────────────────────────────
{
  printf '\n\n##############################################################################\n'
  printf '# Run 1 — frozen ZIP + committed expectation.  Expect 21/21 OK, zip-hash OK.\n'
  printf '##############################################################################\n\n'
} >> "$E"
node --experimental-strip-types "$V" "$ZIP" "$EXP" > "$T/1out" 2> "$T/1err"
R1=$?
filter "$T/1out" >> "$E"
printf '\n' >> "$E"
filter "$T/1err" >> "$E"
printf '\n=== REAL NODE EXIT CODE: %s ===\n' "$R1" >> "$E"

# ── Run 2: tampered expectation → one per-file hash must DIFF ─────────────────
{
  printf '\n\n##############################################################################\n'
  printf '# Run 2 — NEGATIVE CONTROL: one recorded hash corrupted (users).\n'
  printf '# Expect a DIFF on exactly that file, and exit 1.\n'
  printf '##############################################################################\n\n'
} >> "$E"
sed 's/a2a3621bf24f0912/ffffffffffffffff/' "$EXP" > "$T/bad-exp.txt"
node --experimental-strip-types "$V" "$ZIP" "$T/bad-exp.txt" > "$T/2out" 2> "$T/2err"
R2=$?
filter "$T/2err" >> "$E"
printf '\n' >> "$E"
grep -E '^DIFF|got |expected |checksum-match|zip-hash' "$T/2out" >> "$E"
printf '\n=== REAL NODE EXIT CODE: %s ===\n' "$R2" >> "$E"

# ── Run 3: tampered ZIP → zip hash must FAIL ──────────────────────────────────
{
  printf '\n\n##############################################################################\n'
  printf '# Run 3 — NEGATIVE CONTROL: one byte appended to a copy of the ZIP.\n'
  printf '# The 21 entries still extract, but the archive hash must FAIL and exit 1.\n'
  printf '##############################################################################\n\n'
} >> "$E"
cp "$ZIP" "$T/tampered.zip"
printf '\x00' >> "$T/tampered.zip"
node --experimental-strip-types "$V" "$T/tampered.zip" "$EXP" > "$T/3out" 2> "$T/3err"
R3=$?
filter "$T/3err" >> "$E"
printf '\n' >> "$E"
grep -E 'checksum-match|zip-hash|zip-sha256|zip-expected' "$T/3out" >> "$E"
printf '\n=== REAL NODE EXIT CODE: %s ===\n' "$R3" >> "$E"

rm -rf "$T"
echo "Run 1 (real)        exit: $R1  <- must be 0"
echo "Run 2 (bad hash)    exit: $R2  <- must be non-zero"
echo "Run 3 (bad zip)     exit: $R3  <- must be non-zero"
echo "wrote $E"
[ "$R1" -eq 0 ] && [ "$R2" -ne 0 ] && [ "$R3" -ne 0 ]
