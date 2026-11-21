#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "b2k_xy_calibration", ROOT / "klippy" / "extras" / "b2k_xy_calibration.py"
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class CalibrationTests(unittest.TestCase):
    def test_validates_and_records_trigger_and_release_with_host_estimate(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = module.CalibrationRecorder(directory)
            recorder.start({
                "experiment_id": "exp-1", "tool_id": "T2", "axis": "X",
                "direction": "POS", "commanded_distance": 50,
                "speed": 30, "accel": 500, "trial_id": 3,
                "commanded_start_position": 10, "commanded_end_position": 60,
                "temperature": 210,
            }, timestamp_utc="2026-01-01T00:00:00Z", monotonic_time=1.0)
            recorder.switch_event("TRIGGERED", [21, 0, 0, 0], timestamp_utc="2026-01-01T00:00:01Z", monotonic_time=2.0)
            recorder.switch_event("RELEASED", [22, 0, 0, 0], timestamp_utc="2026-01-01T00:00:02Z", monotonic_time=3.0)
            csv_path = recorder.csv_path
            recorder.stop()
            with open(csv_path, encoding="utf-8-sig", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual([r["switch_state"] for r in rows], ["TRIGGERED", "RELEASED"])
            self.assertTrue(all(r["capture_method"] == "host_estimate" for r in rows))
            self.assertEqual(rows[0]["axis"], "X")
            self.assertEqual(float(rows[0]["trigger_position"]), 21.0)

    def test_rejects_invalid_marker_and_nonstandard_distance(self):
        recorder = module.CalibrationRecorder("unused")
        base = {"experiment_id":"e", "tool_id":"T0", "axis":"Q", "direction":"POS",
                "commanded_distance":50, "speed":30, "accel":500, "trial_id":1,
                "commanded_start_position":0, "commanded_end_position":50}
        with self.assertRaises(ValueError):
            recorder.start(base)
        base["axis"] = "X"
        base["commanded_distance"] = 40
        with self.assertRaises(ValueError):
            recorder.start(base)

    def test_report_only_claims_repeatability_and_calculates_spread(self):
        rows = [
            {"experiment_id":"e", "tool_id":"T0", "axis":"X", "direction":"POS", "commanded_distance":"20", "speed":"30", "accel":"500", "commanded_start_position":"0", "temperature":"210", "trial_id":"1", "switch_state":"TRIGGERED", "trigger_position":"10.0", "quality_flags":""},
            {"experiment_id":"e", "tool_id":"T0", "axis":"X", "direction":"POS", "commanded_distance":"20", "speed":"30", "accel":"500", "commanded_start_position":"0", "temperature":"210", "trial_id":"2", "switch_state":"TRIGGERED", "trigger_position":"10.2", "quality_flags":""},
            {"experiment_id":"e", "tool_id":"T0", "axis":"X", "direction":"POS", "commanded_distance":"20", "speed":"30", "accel":"500", "commanded_start_position":"0", "temperature":"210", "trial_id":"3", "switch_state":"TRIGGERED", "trigger_position":"9.8", "quality_flags":""},
        ]
        report = module.analyze_rows(rows)
        group = report["groups"][0]
        self.assertAlmostEqual(group["range_mm"], 0.4)
        self.assertEqual(report["claim_scope"], "repeatability_only")
        self.assertIn("absolute scale error", report["limitations"])

    def test_report_does_not_mix_trials_with_different_speed(self):
        base = {"experiment_id":"e", "tool_id":"T0", "axis":"X", "direction":"POS",
                "commanded_distance":"20", "accel":"500", "commanded_start_position":"0",
                "temperature":"210", "switch_state":"TRIGGERED", "quality_flags":""}
        rows = [dict(base, speed="20", trigger_position="1.0"),
                dict(base, speed="30", trigger_position="1.1")]
        self.assertEqual(len(module.analyze_rows(rows)["groups"]), 2)

    def test_plugin_registers_logging_commands_without_motion_commands(self):
        class GCode:
            def __init__(self): self.commands = {}
            def register_command(self, name, fn, desc=None): self.commands[name] = fn
        class Toolhead:
            def get_position(self): return [5.0, 6.0, 7.0, 0.0]
        class Printer:
            def __init__(self): self.gcode = GCode(); self.toolhead = Toolhead()
            def lookup_object(self, name): return {"gcode":self.gcode, "toolhead":self.toolhead}[name]
            def get_reactor(self): return type("Reactor", (), {"monotonic":lambda self: 123.0})()
        class Config:
            def __init__(self): self.printer = Printer()
            def get_printer(self): return self.printer
            def get(self, key, default=None): return {"output_dir":"unused", "filename_prefix":"b2k_xy"}.get(key, default)
            def get_name(self): return "b2k_xy_calibration"
        plugin = module.B2KXYCalibration(Config())
        commands = plugin.printer.gcode.commands
        self.assertIn("B2K_CAL_START", commands)
        self.assertIn("B2K_SWITCH_EVENT", commands)
        self.assertNotIn("FORCE_MOVE", commands)
        self.assertNotIn("G0", commands)


if __name__ == "__main__":
    unittest.main()
