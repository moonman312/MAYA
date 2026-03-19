"""Unit tests for ``rms_engine.config_loader``."""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from rms_engine import config_loader


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def test_load_all_configs_empty(tmp_path, caplog):
    # point loader at an empty directory
    caplog.set_level("WARNING")
    config_loader.CONFIG_DIR = str(tmp_path)
    assert config_loader.load_all_configs() == {}
    # no warnings should be issued for empty directory
    assert "does not exist" not in caplog.text


def test_load_and_cache_valid_files(tmp_path):
    config_loader.CONFIG_DIR = str(tmp_path)
    file1 = tmp_path / "hotel1.json"
    file2 = tmp_path / "hotel2.json"
    write_json(file1, {"hotel_id": 1, "hotel_name": "One"})
    write_json(file2, {"hotel_id": 2, "hotel_name": "Two"})

    data = config_loader.load_all_configs()
    assert 1 in data and 2 in data
    assert data[1]["hotel_name"] == "One"

    # load into cache via private refresh helper.
    config_loader._refresh_cache()
    assert config_loader.get_config(1)["hotel_name"] == "One"
    assert config_loader.get_config(3) is None


def test_skip_malformed_and_missing_fields(tmp_path, caplog):
    caplog.set_level("WARNING")
    config_loader.CONFIG_DIR = str(tmp_path)
    bad = tmp_path / "bad.json"
    bad.write_text("not json")
    missing = tmp_path / "missing.json"
    write_json(missing, {"hotel_name": "No id"})
    invalid = tmp_path / "invalid.json"
    write_json(invalid, {"hotel_id": "NaN"})
    dup1 = tmp_path / "dup1.json"
    dup2 = tmp_path / "dup2.json"
    write_json(dup1, {"hotel_id": 5})
    write_json(dup2, {"hotel_id": 5})

    data = config_loader.load_all_configs()
    # invalid should be skipped so only 5 appears once
    assert list(data.keys()) == [5]
    assert "Skipping malformed" in caplog.text
    assert "missing hotel_id" in caplog.text
    assert "Invalid hotel_id" in caplog.text
    assert "Duplicate hotel_id" in caplog.text


def test_scheduler_reschedules_and_runs(tmp_path):
    # patch interval to very short and point directory to tmp_path
    config_loader.CONFIG_DIR = str(tmp_path)
    write_json(tmp_path / "a.json", {"hotel_id": 10})
    sched = config_loader.start_config_scheduler(interval_minutes=1)
    assert config_loader.get_config(10) is not None
    # reschedule should not error
    sched = config_loader.start_config_scheduler(interval_minutes=2)
    assert sched is not None
    sched.shutdown()
