"""
Pack the MapEIre 1 km multiband GeoTIFFs into compact grids the map can serve.

Source
------
``rasters_1km/`` (see its ``metadata.md``): one GeoTIFF per year and sector
(2015, 2016, 2019 × 15 GNFR sectors), each with one int16 band per pollutant.
Band descriptions name the pollutant; every band carries its own
``scale_factor`` and ``value_offset`` tags:

    original_value = stored_integer × scale_factor + value_offset

NoData is -32768. The files use TM65 / Irish Grid (EPSG:29902) at 1 000 m, but
GDAL stores that as a LOCAL_CS without an EPSG code, so the CRS is set here
explicitly. Aviation and cruise files have a 50 km buffer (397 × 533 cells),
the others 20 km (337 × 473); both lie on the same 1 km lattice, so every layer
is placed on the larger grid.

Output (numpy only at run time, like EDGAR and the inverse model)
------------------------------------------------------------------
data/MapEIre/<YEAR>_<SECTOR>.npz    one int16 array (rows × cols) per pollutant,
                                    the stored integers unchanged (lossless)
data/MapEIre/mapeire_grid.npz       lat / lng (WGS 84) of every cell centre
data/MapEIre/mapeire_metadata.json  grid, tile-corner coordinates for the web
                                    map, years, sectors, pollutants (labels and
                                    units from data/raster_metadata.json), the
                                    per-band scale / offset, totals and colour
                                    scales

Usage (local machine, environment with rasterio):

    python scripts/build_mapeire_grids.py "C:/.../mapeire/EXTRACTED Zip/rasters_1km"
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import numpy as np

# Use rasterio's own PROJ data (a GIS install's PROJ_LIB can be incompatible), as explorer/rasters.py does
_spec = importlib.util.find_spec("rasterio")
if _spec and _spec.submodule_search_locations:
    _proj = Path(next(iter(_spec.submodule_search_locations))) / "proj_data"
    if (_proj / "proj.db").is_file():
        os.environ["PROJ_DATA"] = os.environ["PROJ_LIB"] = str(_proj)

import rasterio                                      # noqa: E402
from rasterio.warp import transform as warp_transform  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = PROJECT_ROOT / "data" / "MapEIre"
LABELS_PATH = PROJECT_ROOT / "data" / "raster_metadata.json"

CRS = "EPSG:29902"            # TM65 / Irish Grid (the files' LOCAL_CS)
RES = 1000.0
NODATA = -32768
NODE_STEP = 16                # tile size (cells) of the web map's drawing; corner coordinates every 16 cells

# The 2016 combustion file spells its sector in full; all others use the short key
SECTOR_ALIASES = {"C_OtherStationaryCombustion": "C_OtherStationaryComb"}
NAME_RE = re.compile(r"^(\d{4})_(.+)_1km\.tif$")


def to_wgs84(east: np.ndarray, north: np.ndarray):
    lng, lat = warp_transform(CRS, "EPSG:4326", east.ravel().tolist(), north.ravel().tolist())
    return np.asarray(lat).reshape(east.shape), np.asarray(lng).reshape(east.shape)


def read_files(src: Path):
    files = sorted(p for p in src.iterdir() if NAME_RE.match(p.name))
    if not files:
        sys.exit(f"No <YEAR>_<SECTOR>_1km.tif files in {src}")
    layers = []
    for path in files:
        year, sector = NAME_RE.match(path.name).groups()
        sector = SECTOR_ALIASES.get(sector, sector)
        with rasterio.open(path) as ds:
            tags = ds.tags()
            assert ds.dtypes[0] == "int16" and ds.nodata == NODATA, path.name
            assert abs(ds.transform.a - RES) < 1e-6 and abs(ds.transform.e + RES) < 1e-6, path.name
            assert tags.get("source_crs") == CRS, f"{path.name}: unexpected CRS {tags.get('source_crs')}"
            bands = {}
            for i, name in enumerate(ds.descriptions, start=1):
                bt = ds.tags(i)
                scale, offset = float(bt["scale_factor"]), float(bt["value_offset"])
                # The GDAL scale / offset must agree with the band tags
                assert abs(ds.scales[i - 1] - scale) <= 1e-12 * max(1, scale), (path.name, name)
                assert abs(ds.offsets[i - 1] - offset) <= 1e-12 * max(1, abs(offset)), (path.name, name)
                bands[name] = {"data": ds.read(i), "scale": scale, "offset": offset,
                               "source_field": bt.get("source_field", ""),
                               "min_original": float(bt["minimum_original"]),
                               "max_original": float(bt["maximum_original"])}
            layers.append({"file": path.name, "year": year, "sector": sector,
                           "west": ds.transform.c, "north": ds.transform.f,
                           "width": ds.width, "height": ds.height,
                           "buffer_m": int(tags.get("clip_buffer_m", 0)), "bands": bands})
        print(f"read {path.name}: {len(bands)} bands")
    return layers


def decode(q: np.ndarray, scale: float, offset: float) -> np.ndarray:
    """Original values (float64, NaN = NoData); |v| below half a step is exactly zero (as on the page)."""
    v = np.where(q == NODATA, np.nan, q.astype("float64") * scale + offset)
    v[np.abs(v) < scale / 2] = 0.0
    return v


def main(src: Path) -> None:
    layers = read_files(src)
    labels = json.loads(LABELS_PATH.read_text(encoding="utf-8"))

    # ---- the common 1 km grid: the union of every file's extent ----
    west = min(l["west"] for l in layers)
    north = max(l["north"] for l in layers)
    east = max(l["west"] + l["width"] * RES for l in layers)
    south = min(l["north"] - l["height"] * RES for l in layers)
    cols, rows = int(round((east - west) / RES)), int(round((north - south) / RES))
    print(f"grid: {cols} × {rows} cells, west {west}, north {north}")

    # ---- every layer on that grid ----
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.npz"):
        old.unlink()
    valid_any = np.zeros((rows, cols), bool)
    stats, positives, extremes = {}, {}, {}
    for l in layers:
        r0 = int(round((north - l["north"]) / RES))
        c0 = int(round((l["west"] - west) / RES))
        arrays = {}
        info = {"file": l["file"], "buffer_m": l["buffer_m"], "pollutants": {}}
        for code, b in l["bands"].items():
            full = np.full((rows, cols), NODATA, dtype=np.int16)
            full[r0:r0 + l["height"], c0:c0 + l["width"]] = b["data"]
            arrays[code] = full
            v = decode(full, b["scale"], b["offset"])
            ok = np.isfinite(v)
            valid_any |= ok
            vals = v[ok]
            nz = vals[vals != 0]
            info["pollutants"][code] = {
                "scale": b["scale"], "offset": b["offset"],
                "total": float(vals.sum()), "min": float(vals.min()) if vals.size else 0.0,
                "max": float(vals.max()) if vals.size else 0.0,
                "nonzero": int(nz.size), "cells": int(vals.size),
            }
            key = f"{l['sector']}|{code}"
            positives.setdefault(key, []).append(np.abs(nz))
            ext = extremes.setdefault(key, [0.0, 0.0])
            ext[0] = min(ext[0], float(vals.min()) if vals.size else 0.0)
            ext[1] = max(ext[1], float(vals.max()) if vals.size else 0.0)
            # Sanity: the decoded extremes match the band's recorded original min / max
            if vals.size and nz.size:
                tol = b["scale"] * 0.51 + 1e-12
                assert abs(vals.max() - b["max_original"]) <= tol or b["max_original"] < b["scale"] / 2, \
                    (l["file"], code, vals.max(), b["max_original"])
        np.savez_compressed(OUT_DIR / f"{l['year']}_{l['sector']}.npz", **arrays)
        stats[f"{l['year']}|{l['sector']}"] = info

    # ---- colour scales, fixed per sector and pollutant over all years (years compare directly) ----
    scales = {}
    for key, parts in positives.items():
        pos = np.concatenate(parts) if parts else np.array([])
        lo_v, hi_v = extremes[key]
        if pos.size == 0:
            scales[key] = None                       # all-zero in every year
        elif lo_v < 0:
            # Removals (LULUCF CO₂): a symmetric diverging scale around zero
            lim = float(np.percentile(pos, 99)) or float(pos.max())
            scales[key] = {"kind": "div", "lo": -lim, "hi": lim}
        else:
            hi = float(np.percentile(pos, 99.5)) if pos.size > 200 else float(pos.max())
            lo = max(float(np.percentile(pos, 1)), hi * 1e-5)
            if hi <= lo:
                lo, hi = lo / 1.5, hi * 1.5
            scales[key] = {"kind": "log", "lo": lo, "hi": hi}

    # ---- cell centres (time series regions, pixel look-up) ----
    cc, rr = np.meshgrid(np.arange(cols), np.arange(rows))
    lat, lng = to_wgs84(west + (cc + 0.5) * RES, north - (rr + 0.5) * RES)
    np.savez_compressed(OUT_DIR / "mapeire_grid.npz", lat=lat.astype("float32"), lng=lng.astype("float32"),
                        valid=valid_any)

    # ---- tile corners for the web map: lat / lng every NODE_STEP cells (and the far edges) ----
    node_r = sorted(set(list(range(0, rows, NODE_STEP)) + [rows]))
    node_c = sorted(set(list(range(0, cols, NODE_STEP)) + [cols]))
    nc, nr = np.meshgrid(np.array(node_c, float), np.array(node_r, float))
    nlat, nlng = to_wgs84(west + nc * RES, north - nr * RES)
    corners_lat, corners_lng = to_wgs84(np.array([west, east, east, west]), np.array([north, north, south, south]))

    years = sorted({l["year"] for l in layers})
    sector_keys = sorted({l["sector"] for l in layers},
                         key=lambda s: labels["sectors"].get(s, {}).get("order", 99))
    codes = sorted({c for l in layers for c in l["bands"]})
    pollutants = {}
    units = labels.get("units", {})
    for code in codes:
        e = labels["pollutants"].get(code, {"name": code, "formula": code, "group": "Other", "unit": None})
        unit = units.get(e.get("unit") or "")
        pollutants[code] = {
            "name": e["name"], "formula": e.get("formula", code),
            "label": f"{e['name']} ({e['formula']})" if e.get("formula") and e["formula"] != e["name"] else e["name"],
            "group": e.get("group", "Other"),
            "unit": unit["short"] if unit else None, "unit_long": unit["long"] if unit else None,
            "unit_code": e.get("unit"), "name_confirmed": e.get("name_confirmed", True),
        }
    sectors = {}
    for s in sector_keys:
        e = labels["sectors"].get(s, {})
        sectors[s] = {"name": e.get("name", s), "code": e.get("code", ""), "order": e.get("order", 99),
                      "buffer_km": next(l["buffer_m"] for l in layers if l["sector"] == s) // 1000}

    meta = {
        "_about": "Built by scripts/build_mapeire_grids.py from the MapEIre 1 km multiband GeoTIFFs. "
                  "Stored integers are unchanged; value = stored × scale + offset (|value| < scale / 2 is 0).",
        "grid": {
            "crs": CRS, "res": RES, "west": west, "north": north, "rows": rows, "cols": cols,
            "nodata": NODATA, "valid_cells": int(valid_any.sum()),
            "node_step": NODE_STEP, "node_rows": node_r, "node_cols": node_c,
            "node_lat": [round(float(x), 6) for x in nlat.ravel()],
            "node_lng": [round(float(x), 6) for x in nlng.ravel()],
            "bounds": [[round(float(min(corners_lat)), 4), round(float(min(corners_lng)), 4)],
                       [round(float(max(corners_lat)), 4), round(float(max(corners_lng)), 4)]],
        },
        "years": [int(y) for y in years],
        "sectors": sectors,
        "pollutants": pollutants,
        "groups": labels.get("groups", []) + ["Other"],
        "layers": stats,
        "scales": scales,
        "source": {**labels.get("source", {}),
                   "resolution": "1 km × 1 km", "projection": "TM65 / Irish Grid (EPSG:29902)",
                   "report": "Nielsen, O.-K., et al. (2019). MapEIre: National Mapping of Greenhouse Gas and "
                             "Non-greenhouse Gas Emissions Sources. EPA Research Report No. 317.",
                   "url": "https://www.epa.ie/publications/research/reports/research-317-mapeire-national-mapping-"
                          "of-greenhouse-gas-and-non-greenhouse-gas-emissions-sources-project.php",
                   "units_note": "Units are given only where the MapEIre report states them (kt per 1 km cell for "
                                 "CO₂, NOₓ and NH₃); the rasters themselves carry no unit."},
    }
    (OUT_DIR / "mapeire_metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(p.stat().st_size for p in OUT_DIR.iterdir())
    print(f"Wrote {len(layers)} layers ({len(codes)} pollutants, years {years}) to {OUT_DIR}: {size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
