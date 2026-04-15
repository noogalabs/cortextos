#!/usr/bin/env python3
"""
csv_to_kb_chunks.py

Converts an AppFolio work order CSV into markdown chunks for KB ingest.

Usage:
    python3 scripts/csv_to_kb_chunks.py <input_csv> <output_dir>

Example:
    python3 scripts/csv_to_kb_chunks.py ~/Downloads/work_order-20260403.csv ~/Downloads/work_order_chunks/
"""

import csv
import sys
import os
import re
from datetime import datetime
from collections import defaultdict, Counter
from pathlib import Path

OPEN_STATUSES = {'Assigned', 'Waiting', 'New', 'Work Done', 'Assigned by AppFolio'}
COMPLETED_STATUSES = {'Completed', 'Completed No Need To Bill'}


def safe_date(s):
    """Parse MM/DD/YYYY or return None."""
    try:
        return datetime.strptime(s.strip(), '%m/%d/%Y')
    except (ValueError, AttributeError):
        return None


def safe_amount(s):
    """Parse dollar string to float or return None."""
    try:
        return float(re.sub(r'[$,]', '', s.strip()))
    except (ValueError, AttributeError):
        return None


def safe_filename(name):
    """Convert a name to a safe filename."""
    return re.sub(r'[^a-zA-Z0-9_-]', '_', name.strip())[:80]


def load_csv(path):
    """Load CSV, skipping group header rows."""
    rows = []
    with open(path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            prop = row.get('Property', '')
            name = row.get('Property Name', '')
            if not name or prop.startswith('->'):
                continue
            created = row.get('Created At', '').strip()
            if not created:
                print(f'  WARNING: Skipping row with empty Created At (WO# {row.get("Work Order Number","?")})')
                continue
            rows.append(row)
    return rows


def build_property_chunks(rows, output_dir):
    """One markdown chunk per property."""
    by_prop = defaultdict(list)
    for row in rows:
        by_prop[row['Property Name']].append(row)

    written = 0
    for prop_name, prop_rows in by_prop.items():
        address = ''
        for r in prop_rows:
            parts = [r.get('Property Address',''), r.get('Property City',''),
                     r.get('Property State',''), r.get('Property Zip','')]
            addr = ', '.join(p for p in parts if p)
            if addr:
                address = addr
                break

        total = len(prop_rows)
        open_count = sum(1 for r in prop_rows if r.get('Status') in OPEN_STATUSES)
        completed = [r for r in prop_rows if r.get('Status') in COMPLETED_STATUSES]
        canceled = sum(1 for r in prop_rows if r.get('Status') == 'Canceled')

        close_times = []
        for r in completed:
            created = safe_date(r.get('Created At',''))
            done = safe_date(r.get('Completed On',''))
            if created and done and done >= created:
                close_times.append((done - created).days)
        avg_close = f"{sum(close_times)/len(close_times):.1f}" if close_times else "N/A"

        issues = Counter(r.get('Work Order Issue','').strip() for r in prop_rows if r.get('Work Order Issue','').strip())
        top_issues = ', '.join(f"{k}: {v}" for k, v in issues.most_common(5))

        vendors = Counter(r.get('Vendor','').strip() for r in prop_rows if r.get('Vendor','').strip())
        top_vendors = ', '.join(f"{k}: {v}" for k, v in vendors.most_common(3))

        amounts = [a for r in prop_rows for a in [safe_amount(r.get('Amount',''))] if a is not None]
        spend_str = f"${sum(amounts):,.0f}" if amounts else "N/A"

        chunk = f"""# Property: {prop_name}

**Address:** {address or 'N/A'}
**Total work orders:** {total} ({open_count} open, {len(completed)} completed, {canceled} canceled)
**Avg close time:** {avg_close} days
**Total spend:** {spend_str}

**Top issues:** {top_issues or 'N/A'}
**Primary vendors:** {top_vendors or 'N/A'}
"""
        fname = output_dir / f"property_{safe_filename(prop_name)}.md"
        fname.write_text(chunk, encoding='utf-8')
        written += 1

    return written


def build_vendor_chunks(rows, output_dir):
    """One markdown chunk per vendor."""
    by_vendor = defaultdict(list)
    for row in rows:
        vendor = row.get('Vendor','').strip()
        if vendor:
            by_vendor[vendor].append(row)

    written = 0
    for vendor_name, v_rows in by_vendor.items():
        trade = next((r.get('Vendor Trade','') for r in v_rows if r.get('Vendor Trade','')), 'Unknown')
        total = len(v_rows)

        props = sorted({r.get('Property Name','').strip() for r in v_rows if r.get('Property Name','').strip()})
        prop_list = ', '.join(props[:10]) + (f' (+{len(props)-10} more)' if len(props) > 10 else '')

        close_times = []
        for r in v_rows:
            if r.get('Status') in COMPLETED_STATUSES:
                created = safe_date(r.get('Created At',''))
                done = safe_date(r.get('Completed On',''))
                if created and done and done >= created:
                    close_times.append((done - created).days)
        avg_close = f"{sum(close_times)/len(close_times):.1f}" if close_times else "N/A"

        issues = Counter(r.get('Work Order Issue','').strip() for r in v_rows if r.get('Work Order Issue','').strip())
        job_types = ', '.join(f"{k}: {v}" for k, v in issues.most_common(5))

        amounts = [a for r in v_rows for a in [safe_amount(r.get('Amount',''))] if a is not None]
        spend_str = f"${sum(amounts):,.0f}" if amounts else "N/A"

        chunk = f"""# Vendor: {vendor_name}

**Trade:** {trade}
**Total jobs:** {total}
**Total billed:** {spend_str}
**Avg close time:** {avg_close} days
**Properties served:** {prop_list or 'N/A'}
**Job types:** {job_types or 'N/A'}
"""
        fname = output_dir / f"vendor_{safe_filename(vendor_name)}.md"
        fname.write_text(chunk, encoding='utf-8')
        written += 1

    return written


def build_issue_chunks(rows, output_dir):
    """One markdown chunk per issue type."""
    by_issue = defaultdict(list)
    for row in rows:
        issue = row.get('Work Order Issue','').strip()
        if issue:
            by_issue[issue].append(row)

    written = 0
    for issue_name, i_rows in by_issue.items():
        total = len(i_rows)
        props = Counter(r.get('Property Name','').strip() for r in i_rows if r.get('Property Name','').strip())
        top_props = ', '.join(f"{k}: {v}" for k, v in props.most_common(3))
        prop_count = len(props)

        close_times = []
        for r in i_rows:
            if r.get('Status') in COMPLETED_STATUSES:
                created = safe_date(r.get('Created At',''))
                done = safe_date(r.get('Completed On',''))
                if created and done and done >= created:
                    close_times.append((done - created).days)
        avg_close = f"{sum(close_times)/len(close_times):.1f}" if close_times else "N/A"

        month_counts = Counter()
        for r in i_rows:
            d = safe_date(r.get('Created At',''))
            if d:
                month_counts[d.strftime('%B')] += 1
        months_str = ', '.join(f"{m}: {c}" for m, c in sorted(month_counts.items(), key=lambda x: -x[1])[:4]) if month_counts else 'N/A'

        vendors = Counter(r.get('Vendor','').strip() for r in i_rows if r.get('Vendor','').strip())
        top_vendors = ', '.join(f"{k}: {v}" for k, v in vendors.most_common(3))

        chunk = f"""# Issue Type: {issue_name}

**Total occurrences:** {total} across {prop_count} properties
**Avg close time:** {avg_close} days
**Most affected properties:** {top_props or 'N/A'}
**Primary vendors handling this:** {top_vendors or 'N/A'}
**Monthly pattern:** {months_str}
"""
        fname = output_dir / f"issue_{safe_filename(issue_name)}.md"
        fname.write_text(chunk, encoding='utf-8')
        written += 1

    return written


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    input_csv = Path(sys.argv[1]).expanduser()
    output_dir = Path(sys.argv[2]).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f'Loading {input_csv}...')
    rows = load_csv(input_csv)
    print(f'  {len(rows)} data rows loaded')

    print('Writing property chunks...')
    p = build_property_chunks(rows, output_dir)
    print(f'  {p} property chunks written')

    print('Writing vendor chunks...')
    v = build_vendor_chunks(rows, output_dir)
    print(f'  {v} vendor chunks written')

    print('Writing issue type chunks...')
    i = build_issue_chunks(rows, output_dir)
    print(f'  {i} issue chunks written')

    total = p + v + i
    print(f'Done. {total} chunks written to {output_dir}')


if __name__ == '__main__':
    main()
