#!/usr/bin/env python3
"""Download the raw CC0 source assets used by NIGHTWARDEN into .cache/raw/.

Run:  python3 tools/fetch_assets.py
Then: node tools/build-assets.mjs   (optimises into public/assets/)

Every asset fetched here must also be listed in CREDITS.md.
Requires: python3 + requests (pip install requests).
"""
import os, re, sys, json, zipfile
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, '.cache', 'raw')
os.makedirs(RAW, exist_ok=True)
S = requests.Session()
S.headers['User-Agent'] = 'Mozilla/5.0 (nightwarden asset fetcher)'

# ---- Poly Haven (CC0) ------------------------------------------------------
HDRIS = {'kloofendal_48d_partly_cloudy_puresky': '1k'}

# id -> resolution
TEXTURES = {
    'asphalt_02': '2k',
    'concrete_pavement': '1k',
    'herringbone_pavement': '1k',
    'cobblestone_floor_08': '1k',
    'red_brick_03': '1k',
    'brown_brick_02': '1k',
    'large_red_bricks': '1k',
    'large_sandstone_blocks': '1k',
    'concrete_wall_008': '1k',
    'concrete_panels': '1k',
    'plaster_grey_04': '1k',
    'white_plaster_02': '1k',
    'corrugated_iron_02': '1k',
    'container_side': '1k',
    'painted_metal_shutter': '1k',
    'metal_plate': '1k',
    'roof_slates_02': '1k',
    'clay_roof_tiles_02': '1k',
    'leafy_grass': '1k',
    'coast_sand_01': '1k',
    'weathered_planks': '1k',
    'granite_tile': '1k',
    'rough_concrete': '1k',
    'rusty_metal_02': '1k',
    'bark_platanus': '1k',
    'forest_leaves_02': '1k',
}
TEX_MAPS = {'Diffuse': 'diff', 'nor_gl': 'nor_gl', 'arm': 'arm'}

MODELS = [
    'fire_hydrant', 'metal_trash_can', 'painted_wooden_bench', 'exterior_aircon_unit',
    'utility_box_01', 'concrete_road_barrier', 'wooden_crate_01', 'Barrel_01',
    'lateral_sea_marker', 'planter_box_01', 'wooden_picnic_table', 'water_manhole_cover',
]


def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print('GET', url)
    with S.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(path + '.part', 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    os.replace(path + '.part', path)
    return path


def polyhaven():
    for hid, res in HDRIS.items():
        files = S.get(f'https://api.polyhaven.com/files/{hid}').json()
        get(files['hdri'][res]['hdr']['url'], os.path.join(RAW, 'polyhaven', 'hdri', f'{hid}_{res}.hdr'))
    for tid, res in TEXTURES.items():
        files = S.get(f'https://api.polyhaven.com/files/{tid}').json()
        for key, short in TEX_MAPS.items():
            url = files[key][res]['jpg']['url']
            get(url, os.path.join(RAW, 'polyhaven', 'textures', tid, f'{tid}_{short}.jpg'))
    for mid in MODELS:
        files = S.get(f'https://api.polyhaven.com/files/{mid}').json()
        g = files['gltf']['1k']['gltf']
        d = os.path.join(RAW, 'polyhaven', 'models', mid)
        get(g['url'], os.path.join(d, os.path.basename(g['url'])))
        for rel, inc in g['include'].items():
            get(inc['url'], os.path.join(d, rel))


# ---- Quaternius via itch.io (CC0) -----------------------------------------
ITCH = [
    ('quaternius', 'universal-animation-library', 'Standard', 'ual.zip'),
    ('quaternius', 'universal-base-characters', 'Standard', 'ubc.zip'),
]


def itch(user, game, want, out):
    path = os.path.join(RAW, 'quaternius', out)
    if not os.path.exists(path):
        base = f'https://{user}.itch.io/{game}'
        h = S.get(base).text
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', h).group(1)
        dl = S.post(base + '/download_url', data={'csrf_token': csrf}).json()['url']
        dp = S.get(dl).text
        uploads = []
        for m in re.finditer(r'data-upload_id="(\d+)"', dp):
            seg = dp[m.start():m.start() + 3000]
            n = re.search(r'title="([^"]+)"', seg)
            uploads.append((m.group(1), n.group(1) if n else ''))
        uid = next(u for u, n in uploads if want in n)
        r = S.post(f'{base}/file/{uid}', params={'source': 'view_game', 'as_props': '1', 'after_download_lightbox': 'true'},
                   data={'csrf_token': csrf}, headers={'X-Requested-With': 'XMLHttpRequest'})
        get(r.json()['url'], path)
    dest = os.path.join(RAW, 'quaternius', os.path.splitext(out)[0])
    if not os.path.isdir(dest):
        with zipfile.ZipFile(path) as z:
            z.extractall(dest)


if __name__ == '__main__':
    polyhaven()
    for args in ITCH:
        itch(*args)
    print('done ->', RAW)
