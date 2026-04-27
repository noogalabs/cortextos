#!/usr/bin/env python3
"""
External Vendor Assignment Wrapper

Safely assigns a vendor to a meld via the Property Meld API.
Validates inputs, handles errors, and uses environment variables.
"""

import sys
import os
import json
from pathlib import Path

def get_pm_lib_path():
    """Get PM library path from env or use default."""
    default = os.path.expanduser("~/projects/cli-anything-propertymeld")
    return os.getenv("PM_LIB_PATH", default)

def validate_inputs(meld_id, vendor_id, account=None):
    """Validate meld_id and vendor_id are positive integers."""
    try:
        meld_int = int(meld_id)
        vendor_int = int(vendor_id)
        if meld_int <= 0 or vendor_int <= 0:
            raise ValueError("IDs must be positive integers")
        return meld_int, vendor_int
    except (ValueError, TypeError) as e:
        print(f"❌ Invalid input: {e}", file=sys.stderr)
        sys.exit(1)

def assign_vendor(meld_id, vendor_id, account=None):
    """Assign vendor to meld using http_backend."""
    meld_int, vendor_int = validate_inputs(meld_id, vendor_id, account)

    pm_lib = get_pm_lib_path()
    sys.path.insert(0, pm_lib)

    try:
        from cli_anything.propertymeld import http_backend
    except ImportError as e:
        print(f"❌ Failed to import cli_anything.propertymeld: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        creds = http_backend._load_creds()
        cookie_hdr = http_backend._cookie_header(creds)
        csrf_token = http_backend._get_csrf_token(cookie_hdr)

        # Build vendor object with composite_id
        account_prefix = account or "1"
        vendor_obj = {
            "type": "Vendor",
            "id": vendor_int,
            "composite_id": f"{account_prefix}-{vendor_int}"
        }

        # Patch the meld's maintenance field
        response = http_backend._http_patch(
            f"melds/{meld_int}/assign-maintenance/",
            {"maintenance": [vendor_obj]},
            cookie_hdr,
            csrf_token
        )

        if response.get("status_code") in [200, 201]:
            print(f"✓ Vendor {vendor_int} assigned to meld {meld_int}")
            print(f"  Status: {response.get('status', 'PENDING_VENDOR')}")
            return 0
        else:
            print(f"❌ Assignment failed: {response}", file=sys.stderr)
            return 1

    except Exception as e:
        print(f"❌ Error during assignment: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: pm-assign-vendor.py <meld_id> <vendor_id> [account_prefix]", file=sys.stderr)
        sys.exit(1)

    meld_id = sys.argv[1]
    vendor_id = sys.argv[2]
    account = sys.argv[3] if len(sys.argv) > 3 else None

    sys.exit(assign_vendor(meld_id, vendor_id, account))
