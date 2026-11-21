#!/usr/bin/env python3
"""Create a repeatability-only JSON report from B2K V0.1 event CSV."""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "klippy", "extras"))
from b2k_xy_calibration import analyze_csv


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path")
    parser.add_argument("--output", help="JSON report path (default: alongside CSV)")
    args = parser.parse_args()
    output = args.output or os.path.splitext(args.csv_path)[0] + "_report.json"
    report = analyze_csv(args.csv_path, output)
    print("Wrote %s (%d groups; repeatability only)" % (output, len(report["groups"])))


if __name__ == "__main__":
    main()
