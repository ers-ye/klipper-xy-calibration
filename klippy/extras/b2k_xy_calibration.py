# SPDX-License-Identifier: Apache-2.0
# B2K XY Calibration V0.1 - passive single-switch event logger.
# This module deliberately contains no movement or stepper-control calls.
import csv
import datetime
import json
import logging
import math
import os
import re
import statistics
import time

LOG = logging.getLogger(__name__)
CSV_FIELDS = [
    "experiment_id", "timestamp_utc", "monotonic_time", "tool_id", "axis",
    "direction", "commanded_distance", "speed", "accel", "trial_id",
    "commanded_start_position", "commanded_end_position", "trigger_position",
    "capture_method", "switch_state", "temperature", "quality_flags",
]
DISTANCES = (20.0, 50.0, 100.0)
AXES = ("X", "Y", "Z")
DIRECTIONS = ("POS", "NEG")


def _utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _number(value, name, minimum=None):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be numeric" % name)
    if not math.isfinite(result):
        raise ValueError("%s must be finite" % name)
    if minimum is not None and result < minimum:
        raise ValueError("%s must be >= %s" % (name, minimum))
    return result


def _safe_id(value, name):
    value = str(value).strip()
    if not value or not re.match(r"^[A-Za-z0-9_.-]+$", value):
        raise ValueError("%s must contain only letters, digits, dot, dash, underscore" % name)
    return value


class CalibrationRecorder:
    """Stores one active experiment marker and appends switch events to CSV."""

    def __init__(self, output_dir, filename_prefix="b2k_xy"):
        self.output_dir = os.path.abspath(os.path.expanduser(output_dir))
        self.filename_prefix = _safe_id(filename_prefix, "filename_prefix")
        self.active = None
        self.csv_path = None

    def start(self, marker, timestamp_utc=None, monotonic_time=None):
        if self.active is not None:
            raise ValueError("an experiment is already active; stop it first")
        row = dict(marker)
        row["experiment_id"] = _safe_id(row.get("experiment_id"), "experiment_id")
        row["tool_id"] = _safe_id(row.get("tool_id"), "tool_id")
        row["axis"] = str(row.get("axis", "")).upper()
        row["direction"] = str(row.get("direction", "")).upper()
        if row["axis"] not in AXES:
            raise ValueError("axis must be X, Y, or Z")
        if row["direction"] not in DIRECTIONS:
            raise ValueError("direction must be POS or NEG")
        row["commanded_distance"] = _number(row.get("commanded_distance"), "commanded_distance", 0.0)
        if row["commanded_distance"] not in DISTANCES:
            raise ValueError("commanded_distance must be 20, 50, or 100 mm")
        row["speed"] = _number(row.get("speed"), "speed", 0.0)
        if row["speed"] == 0:
            raise ValueError("speed must be greater than zero")
        row["accel"] = _number(row.get("accel"), "accel", 0.0)
        if row["accel"] == 0:
            raise ValueError("accel must be greater than zero")
        try:
            row["trial_id"] = int(row.get("trial_id"))
        except (TypeError, ValueError):
            raise ValueError("trial_id must be a positive integer")
        if row["trial_id"] < 1:
            raise ValueError("trial_id must be a positive integer")
        row["commanded_start_position"] = _number(row.get("commanded_start_position"), "commanded_start_position")
        row["commanded_end_position"] = _number(row.get("commanded_end_position"), "commanded_end_position")
        row["temperature"] = "" if row.get("temperature") is None else _number(row.get("temperature"), "temperature")
        row["timestamp_utc"] = timestamp_utc or _utc_now()
        row["monotonic_time"] = time.monotonic() if monotonic_time is None else _number(monotonic_time, "monotonic_time")
        row["quality_flags"] = "HOST_ESTIMATE;NO_INDEPENDENT_LENGTH_REFERENCE"

        if not os.path.isdir(self.output_dir):
            os.makedirs(self.output_dir)
        self.csv_path = os.path.join(self.output_dir, "%s_%s.csv" % (self.filename_prefix, row["experiment_id"]))
        self.active = row
        return self.csv_path

    def switch_event(self, state, position, timestamp_utc=None, monotonic_time=None):
        if self.active is None:
            raise ValueError("no active experiment; run B2K_CAL_START first")
        state = str(state).upper()
        if state not in ("TRIGGERED", "RELEASED"):
            raise ValueError("switch state must be TRIGGERED or RELEASED")
        if not isinstance(position, (list, tuple)) or len(position) < 3:
            raise ValueError("host position must contain X, Y, and Z")
        axis_index = {"X": 0, "Y": 1, "Z": 2}[self.active["axis"]]
        trigger_position = _number(position[axis_index], "host_estimate position")
        row = dict(self.active)
        row.update({
            "timestamp_utc": timestamp_utc or _utc_now(),
            "monotonic_time": time.monotonic() if monotonic_time is None else _number(monotonic_time, "monotonic_time"),
            "trigger_position": trigger_position,
            "capture_method": "host_estimate",
            "switch_state": state,
            "quality_flags": "HOST_ESTIMATE;NO_INDEPENDENT_LENGTH_REFERENCE",
        })
        with open(self.csv_path, "a", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
            if stream.tell() == 0:
                writer.writeheader()
            writer.writerow(row)
        return row

    def stop(self):
        self.active = None
        self.csv_path = None

def analyze_rows(rows):
    """Summarize trigger-position repeatability; never infer scale accuracy."""
    groups = {}
    for row in rows:
        if row.get("switch_state") != "TRIGGERED":
            continue
        try:
            value = float(row["trigger_position"])
            distance = float(row["commanded_distance"])
        except (KeyError, TypeError, ValueError):
            continue
        key = (row.get("experiment_id", ""), row.get("tool_id", ""), row.get("axis", ""),
               row.get("direction", ""), distance, row.get("speed", ""),
               row.get("accel", ""), row.get("commanded_start_position", ""),
               row.get("temperature", ""))
        groups.setdefault(key, []).append(value)
    summaries = []
    for key, values in sorted(groups.items()):
        summaries.append({
            "experiment_id": key[0], "tool_id": key[1], "axis": key[2], "direction": key[3],
            "commanded_distance_mm": key[4], "trigger_samples": len(values),
            "speed": key[5], "accel": key[6], "commanded_start_position": key[7],
            "temperature": key[8],
            "mean_host_estimate_mm": statistics.mean(values),
            "range_mm": max(values) - min(values),
            "sample_stdev_mm": statistics.stdev(values) if len(values) > 1 else None,
        })
    return {
        "title": "B2K XY Calibration V0.1 repeatability report",
        "claim_scope": "repeatability_only",
        "groups": summaries,
        "limitations": [
            "Trigger positions are host_estimate values from the gcode_button callback path, not MCU-latched coordinates.",
            "Without an independent length reference, commanded distances cannot establish absolute scale error.",
            "This report summarizes repeatability only and does not modify printer motion parameters.",
        ],
    }


def analyze_csv(csv_path, report_path=None):
    with open(csv_path, "r", newline="", encoding="utf-8-sig") as stream:
        report = analyze_rows(list(csv.DictReader(stream)))
    if report_path:
        with open(report_path, "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return report


class B2KXYCalibration:
    """Klipper extras plugin; gcode_button forwards its one pin's state here."""

    def __init__(self, config):
        self.printer = config.get_printer()
        output_dir = config.get("output_dir", "~/printer_data/logs/b2k_xy")
        prefix = config.get("filename_prefix", "b2k_xy")
        self.recorder = CalibrationRecorder(output_dir, prefix)
        self.gcode = self.printer.lookup_object("gcode")
        self.toolhead = self.printer.lookup_object("toolhead")
        self.reactor = self.printer.get_reactor()
        self.gcode.register_command("B2K_CAL_START", self.cmd_CAL_START,
                                    desc="Mark a passive B2K calibration experiment")
        self.gcode.register_command("B2K_CAL_STOP", self.cmd_CAL_STOP,
                                    desc="Stop B2K calibration event logging")
        self.gcode.register_command("B2K_SWITCH_EVENT", self.cmd_SWITCH_EVENT,
                                    desc="Record a single GPIO switch state event")
        self.gcode.register_command("B2K_CAL_REPORT", self.cmd_CAL_REPORT,
                                    desc="Write a repeatability-only JSON report")

    def _error(self, gcmd, error):
        LOG.exception("B2K XY Calibration command failed", exc_info=error)
        raise gcmd.error("B2K XY Calibration: %s" % error)

    def cmd_CAL_START(self, gcmd):
        try:
            marker = {
                "experiment_id": gcmd.get("EXPERIMENT_ID"), "tool_id": gcmd.get("TOOL_ID"),
                "axis": gcmd.get("AXIS"), "direction": gcmd.get("DIRECTION"),
                "commanded_distance": gcmd.get_float("DISTANCE"), "speed": gcmd.get_float("SPEED"),
                "accel": gcmd.get_float("ACCEL"), "trial_id": gcmd.get("TRIAL"),
                "commanded_start_position": gcmd.get_float("START_POS"),
                "commanded_end_position": gcmd.get_float("END_POS"),
                "temperature": gcmd.get_float("TEMPERATURE", None),
            }
            path = self.recorder.start(marker)
            gcmd.respond_info("B2K logging active; CSV: %s. No motion was issued." % path)
        except Exception as error:
            self._error(gcmd, error)

    def cmd_CAL_STOP(self, gcmd):
        self.recorder.stop()
        gcmd.respond_info("B2K event logging stopped.")

    def cmd_SWITCH_EVENT(self, gcmd):
        try:
            position = self.toolhead.get_position()
            row = self.recorder.switch_event(gcmd.get("STATE"), position,
                                             monotonic_time=self.reactor.monotonic())
            gcmd.respond_info("Recorded %s switch event (%s host_estimate %.4f mm)." %
                              (row["switch_state"], row["axis"], row["trigger_position"]))
        except Exception as error:
            self._error(gcmd, error)

    def cmd_CAL_REPORT(self, gcmd):
        try:
            path = gcmd.get("CSV", None)
            if not path:
                path = self.recorder.csv_path
            if not path:
                raise ValueError("provide CSV=<path> or start an experiment first")
            output = gcmd.get("OUTPUT", os.path.splitext(path)[0] + "_report.json")
            analyze_csv(path, output)
            gcmd.respond_info("B2K repeatability-only report written: %s" % output)
        except Exception as error:
            self._error(gcmd, error)

def load_config(config):
    return B2KXYCalibration(config)
