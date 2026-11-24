"""
MapEIre national gridded emissions (1 km, Irish Grid) for the Spatial Environmental Mapping panel.

The multiband GeoTIFFs (one per year and sector, one band per pollutant) are packed by
``scripts/build_mapeire_grids.py`` into ``data/MapEIre/<YEAR>_<SECTOR>.npz`` (the stored int16
integers of each pollutant on one 397 × 533 grid), ``mapeire_grid.npz`` (cell centres in WGS 84)
and ``mapeire_metadata.json``, so this module needs numpy only, like ``edgar`` and ``inverse``.

Values: ``value = stored × scale + offset`` with the band's own scale and offset; NoData is -32768
and |value| below half a step is exactly zero (the rule the page applies too). The layer API sends
the stored integers and lets the page decode them: a 1 km grid as integers is small once gzipped.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Dict, Optional

import numpy as np

BASE_DIR = Path(__file__).resolve().parent.parent
MAPEIRE_DIR = BASE_DIR / "data" / "MapEIre"
METADATA_PATH = MAPEIRE_DIR / "mapeire_metadata.json"
GRID_PATH = MAPEIRE_DIR / "mapeire_grid.npz"

_META_CACHE: Dict[str, object] = {"mtime": None, "data": {}}
_LAYER_CACHE: Dict[str, np.ndarray] = {}
_CENTRES: Dict[str, np.ndarray] = {}
_LOCK = threading.Lock()
_CACHE_MAX = 48                      # decoded layers kept per worker (~0.4 MB each)


def load_metadata() -> dict:
    """Return ``mapeire_metadata.json``, re-read whenever the file changes."""
    try:
        mtime = METADATA_PATH.stat().st_mtime
    except OSError:
        return {}
    if _META_CACHE["mtime"] != mtime:
        try:
            data = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
        except ValueError:
            data = {}
        _META_CACHE.update(mtime=mtime, data=data)
    return _META_CACHE["data"]  # type: ignore[return-value]


def band_info(year: str, sector: str, pollutant: str) -> Optional[dict]:
    """Scale, offset, total … of one layer, or ``None`` if the selection does not exist."""
    entry = load_metadata().get("layers", {}).get(f"{year}|{sector}")
    if not entry:
        return None
    return entry["pollutants"].get(pollutant)


def stored(year: str, sector: str, pollutant: str) -> Optional[np.ndarray]:
    """The stored int16 grid (rows × cols) of a valid selection; checked against the metadata."""
    if band_info(year, sector, pollutant) is None:
        return None
    key = f"{year}|{sector}|{pollutant}"
    with _LOCK:
        arr = _LAYER_CACHE.get(key)
    if arr is None:
        with np.load(MAPEIRE_DIR / f"{year}_{sector}.npz") as npz:
            arr = npz[pollutant]
        with _LOCK:
            if len(_LAYER_CACHE) >= _CACHE_MAX:
                _LAYER_CACHE.pop(next(iter(_LAYER_CACHE)))
            _LAYER_CACHE[key] = arr
    return arr


def values(year: str, sector: str, pollutant: str) -> Optional[np.ndarray]:
    """Decoded float64 grid (rows × cols): NaN = NoData, near-zero snapped to 0."""
    q = stored(year, sector, pollutant)
    if q is None:
        return None
    b = band_info(year, sector, pollutant)
    nodata = load_metadata()["grid"]["nodata"]
    v = np.where(q == nodata, np.nan, q.astype("float64") * b["scale"] + b["offset"])
    v[np.abs(v) < b["scale"] / 2] = 0.0
    return v


def centres() -> Dict[str, np.ndarray]:
    """``lat`` / ``lng`` (rows × cols, float64) of every cell centre and the ``valid`` mask."""
    with _LOCK:
        if not _CENTRES:
            with np.load(GRID_PATH) as npz:
                _CENTRES.update(lat=npz["lat"].astype("float64"), lng=npz["lng"].astype("float64"),
                                valid=npz["valid"])
        return dict(_CENTRES)


def cell_at(lat: float, lng: float) -> Optional[int]:
    """Flat index of the 1 km cell containing (lat, lng), or ``None`` outside the grid.

    The cell whose centre is nearest in a local metric frame; a point farther than ~0.72 km from
    every centre on either axis (the half cell plus the grid's rotation) is outside the grid."""
    c = centres()
    k = np.cos(np.radians(lat))
    dx = (c["lng"] - lng) * k * 111.32
    dy = (c["lat"] - lat) * 111.32
    d = dx * dx + dy * dy
    i = int(np.argmin(d))
    if max(abs(dx.flat[i]), abs(dy.flat[i])) > 0.72:
        return None
    return i


def layer(year: str, sector: str, pollutant: str) -> Optional[dict]:
    """
    The stored integers and everything needed to decode and colour them, or ``None`` if the
    selection is not valid. Inputs are checked against the metadata, never used to build a path.
    """
    meta = load_metadata()
    b = band_info(year, sector, pollutant)
    if b is None or sector not in meta.get("sectors", {}) or pollutant not in meta.get("pollutants", {}):
        return None
    q = stored(year, sector, pollutant)
    p = meta["pollutants"][pollutant]
    return {
        "q": q.ravel().tolist(),
        "nodata": meta["grid"]["nodata"],
        "scale": b["scale"], "offset": b["offset"],
        "unit": p["unit"], "unit_long": p["unit_long"],
        "total": b["total"], "min": b["min"], "max": b["max"],
        "nonzero_cells": b["nonzero"], "cells": b["cells"],
        "all_zero": b["nonzero"] == 0,
        "colour": meta["scales"].get(f"{sector}|{pollutant}"),
    }


def catalog() -> dict:
    """Everything the page needs to build the MapEIre dropdowns, draw the grid and label the layers."""
    meta = load_metadata()
    if not meta:
        return {}
    avail = {}
    for key, entry in meta["layers"].items():
        year, sector = key.split("|")
        avail.setdefault(year, {})[sector] = {
            code: {"nonzero": p["nonzero"], "total": p["total"]} for code, p in entry["pollutants"].items()}
    # The data version (the metadata file's modification time): the page adds it to every layer URL,
    # so a rebuilt dataset is never served from a browser cache of the old one
    version = str(int(_META_CACHE["mtime"] or 0))
    return {k: meta[k] for k in ("grid", "years", "sectors", "pollutants", "groups", "scales", "source") if k in meta} \
        | {"layers": avail, "version": version}
