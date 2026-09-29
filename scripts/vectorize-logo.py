"""Deterministically trace the existing teal brand mark; no generated artwork.

Run with Pillow installed. Removes the off-white matte and emits a scalable SVG.
"""
from collections import defaultdict
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[1]
im = Image.open(root / 'public/brand/logo-icon.png').convert('RGBA')
w, h = im.size
pixels = im.load()
mask = {(x, y) for y in range(h) for x in range(w)
        if pixels[x, y][3] > 100 and min(pixels[x, y][1:3]) - pixels[x, y][0] > 35}
edges = defaultdict(list)
for x, y in mask:
    if (x, y - 1) not in mask: edges[(x, y)].append((x + 1, y))
    if (x + 1, y) not in mask: edges[(x + 1, y)].append((x + 1, y + 1))
    if (x, y + 1) not in mask: edges[(x + 1, y + 1)].append((x, y + 1))
    if (x - 1, y) not in mask: edges[(x, y + 1)].append((x, y))

def simplify(points, tolerance=0.65):
    if len(points) < 3: return points
    ax, ay = points[0]; bx, by = points[-1]
    length = ((bx-ax)**2 + (by-ay)**2)**0.5 or 1
    distances = [abs((bx-ax)*(ay-y) - (ax-x)*(by-ay))/length for x,y in points]
    distance = max(distances); i = distances.index(distance)
    if distance <= tolerance: return [points[0], points[-1]]
    return simplify(points[:i+1], tolerance)[:-1] + simplify(points[i:], tolerance)

paths = []
while edges:
    start = min(edges); point = start; loop = [start]
    while True:
        nxt = edges[point].pop()
        if not edges[point]: del edges[point]
        point = nxt
        if point == start: break
        loop.append(point)
    if len(loop) < 20: continue  # JPEG-like dust, never a part of the mark
    half = len(loop)//2
    points = simplify(loop[:half+1])[:-1] + simplify(loop[half:] + [loop[0]])[:-1]
    def midpoint(a,b): return ((a[0]+b[0])/2, (a[1]+b[1])/2)
    def text(p): return f'{p[0]:g},{p[1]:g}'
    # Rounded subpixel corners along the traced outline remove raster stair steps.
    path = 'M' + text(midpoint(points[-1], points[0]))
    for i, point in enumerate(points):
        path += ' Q' + text(point) + ' ' + text(midpoint(point, points[(i+1)%len(points)]))
    paths.append(path + ' Z')
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><title>Hopr</title><path fill="#237a7d" fill-rule="evenodd" d="{" ".join(paths)}"/></svg>\n'
(root / 'public/brand/logo-mark.svg').write_text(svg, encoding='utf-8')
print(f'Traced {len(paths)} contours into logo-mark.svg ({len(svg)} bytes)')
