#!/usr/bin/env python3
"""
Trim large `lines` arrays in a Slither JSON report and produce summary files.

Writes:
- `sliver-report-trimmed.json` : same structure but with `lines` replaced by a small summary
- `slither-summary.md` : markdown summary with detector counts and top findings
- `slither-detector-counts.csv` : CSV with detector,count,impact,confidence

Run from the repo root where `sliver-report.json` exists.
"""
import json
from pathlib import Path
from collections import Counter, defaultdict
import sys

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "sliver-report.json"
TRIMMED = ROOT / "sliver-report-trimmed.json"
SUMMARY_MD = ROOT / "slither-summary.md"
COUNTS_CSV = ROOT / "slither-detector-counts.csv"

if not INPUT.exists():
    print(f"Input file not found: {INPUT}")
    sys.exit(2)

with INPUT.open('r', encoding='utf-8') as f:
    data = json.load(f)

results = data.get('results') or {}

detectors = results.get('detectors') if isinstance(results, dict) else results
if detectors is None:
    print("No detectors found in report (unexpected format). Exiting.")
    sys.exit(0)

counts = Counter()
impact_counts = defaultdict(Counter)
confidence_counts = defaultdict(Counter)

top_examples = defaultdict(list)

def summarize_lines(lines):
    if not isinstance(lines, list):
        return lines
    n = len(lines)
    if n <= 10:
        return {'count': n, 'lines_preview': lines}
    return {
        'count': n,
        'first': lines[:5],
        'last': lines[-5:]
    }

trimmed_detectors = []

for det in detectors:
    check = det.get('check') or 'unknown'
    counts[check] += 1
    impact = det.get('impact') or ''
    confidence = det.get('confidence') or ''
    impact_counts[check][impact] += 1
    confidence_counts[check][confidence] += 1

    # store up to 3 examples per check
    if len(top_examples[check]) < 3:
        top_examples[check].append(det)

    # Trim `elements` -> `source_mapping`.`lines`
    det_copy = dict(det)
    elems = det_copy.get('elements') or []
    new_elems = []
    for e in elems:
        e_copy = dict(e)
        sm = e_copy.get('source_mapping')
        if isinstance(sm, dict):
            lines = sm.get('lines')
            if lines is not None:
                sm = dict(sm)
                sm['lines'] = summarize_lines(lines)
                e_copy['source_mapping'] = sm
        # also handle nested parents inside type_specific_fields
        tsf = e_copy.get('type_specific_fields') or {}
        if isinstance(tsf, dict):
            parent = tsf.get('parent')
            if isinstance(parent, dict):
                psm = parent.get('source_mapping')
                if isinstance(psm, dict) and 'lines' in psm:
                    psm = dict(psm)
                    psm['lines'] = summarize_lines(psm.get('lines'))
                    parent = dict(parent)
                    parent['source_mapping'] = psm
                    tsf = dict(tsf)
                    tsf['parent'] = parent
                    e_copy['type_specific_fields'] = tsf
        new_elems.append(e_copy)
    det_copy['elements'] = new_elems
    trimmed_detectors.append(det_copy)

# Build trimmed results
trimmed = dict(data)
trimmed_results = dict(results) if isinstance(results, dict) else {}
trimmed_results['detectors'] = trimmed_detectors
trimmed['results'] = trimmed_results

with TRIMMED.open('w', encoding='utf-8') as f:
    json.dump(trimmed, f, indent=2)

# Write CSV counts
with COUNTS_CSV.open('w', encoding='utf-8') as f:
    f.write('check,count,top_impact,top_confidence\n')
    for check, cnt in counts.most_common():
        top_imp = impact_counts[check].most_common(1)[0][0] if impact_counts[check] else ''
        top_conf = confidence_counts[check].most_common(1)[0][0] if confidence_counts[check] else ''
        f.write(f'"{check}",{cnt},"{top_imp}","{top_conf}"\n')

# Write markdown summary
with SUMMARY_MD.open('w', encoding='utf-8') as f:
    f.write('# Slither Summary\n\n')
    total = sum(counts.values())
    f.write(f'- Total findings: **{total}**\n')
    f.write(f'- Unique detector types: **{len(counts)}**\n\n')

    f.write('## Top detectors (by count)\n\n')
    for check, cnt in counts.most_common(30):
        f.write(f'- **{check}**: {cnt}\n')
    f.write('\n')

    f.write('## Representative findings (up to 3 per detector)\n\n')
    for check, examples in list(top_examples.items())[:30]:
        f.write(f'### {check} ({counts[check]})\n')
        for ex in examples:
            desc = ex.get('description') or ex.get('markdown') or ''
            impact = ex.get('impact','')
            conf = ex.get('confidence','')
            f.write(f'- Impact: {impact} • Confidence: {conf}\n')
            # Avoid backslashes inside f-string expressions
            desc_formatted = desc.strip().replace("\n", "\n  - ")
            if desc_formatted:
                f.write('  - ' + desc_formatted + "\n")
        f.write('\n')

print('Trimmed report written to:', TRIMMED)
print('Summary written to:', SUMMARY_MD)
print('Counts CSV written to:', COUNTS_CSV)

if __name__ == '__main__':
    pass
