"""Step 2 of a bake (office/baked/README.md): bake the evening light in Blender.

Reads static.glb and export.json from step 1, joins the parts into one mesh, lays out a second set of
UVs for the bake, and bakes two textures with Cycles:
  light.png  the light that bounces around the room (not the direct light: the page draws that live)
  ao.png     ambient occlusion, how hidden each point is from open air
Then writes room.glb (the joined mesh, both UV sets, material names but no images) and bake.json.

Runs with Blender's Python module: pip install bpy, then
  python3 office/baked/bake.py <work folder> <out folder> [--size 2048] [--samples 64]
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument('work')
p.add_argument('out')
p.add_argument('--size', type=int, default=2048)
p.add_argument('--samples', type=int, default=64)
p.add_argument('--ao-samples', type=int, default=32)
a = p.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
os.makedirs(a.out, exist_ok=True)
info = json.load(open(os.path.join(a.work, 'export.json')))


def to_blender(v):
    """three.js and glTF are Y-up, Blender is Z-up."""
    return Vector((v[0], -v[2], v[1]))


def linear(hex_colour):
    c = [int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# ---------- the parts, joined ----------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(a.work, 'static.glb'))
scene = bpy.context.scene
for o in list(scene.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in scene.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.make_single_user(object=True, obdata=True)
bpy.ops.object.join()
room = bpy.context.view_layer.objects.active
room.name = 'Room'
print('joined', len(meshes), 'parts:', len(room.data.polygons), 'faces,', len(room.material_slots), 'materials')

# ---------- a second set of UVs for the bake ----------
uv = room.data.uv_layers.new(name='LightMap')
room.data.uv_layers.active = uv
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.pack_islands(margin=4 / a.size, rotate=True)
bpy.ops.object.mode_set(mode='OBJECT')

# ---------- the evening light, the same as the page's sun and lamps ----------
sun_data = bpy.data.lights.new('Sun', 'SUN')
sun_data.energy = 7.0
sun_data.color = (1.0, 0.5, 0.22)
sun_data.angle = math.radians(1.0)
sun = bpy.data.objects.new('Sun', sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (-to_blender(info['sun']['from'])).to_track_quat('-Z', 'Y').to_euler()
for i, l in enumerate(info['lights']):
    neon = l['color'].lower().startswith('#ff') and int(l['color'][3:5], 16) < 0x40
    ld = bpy.data.lights.new(f'Lamp{i}', 'POINT')
    ld.energy = 27.0 if neon else 45.0
    ld.color = linear(l['color']) if neon else (1.0, 0.68, 0.38)
    ld.shadow_soft_size = 0.08
    lo = bpy.data.objects.new(f'Lamp{i}', ld)
    scene.collection.objects.link(lo)
    lo.location = to_blender(l['at'])
# The loft's ceiling, which the page leaves off so you can see in. It keeps the low sun out except
# through the windows, and it bounces light like a real one.
bpy.ops.mesh.primitive_plane_add(size=1, location=(-0.15, 0.15, 4.62))
ceil = bpy.context.active_object
ceil.scale = (14.6, 10.6, 1)
cm = bpy.data.materials.new('Ceiling')
cm.use_nodes = True
cm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.3, 0.27, 1)
ceil.data.materials.append(cm)
world = bpy.data.worlds.new('Dusk')
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (0.55, 0.5, 0.75, 1)
bg.inputs['Strength'].default_value = 0.12
world.light_settings.distance = 0.8  # how far ambient occlusion looks, in metres

# ---------- bake ----------
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.render.bake.margin = 8
scene.render.bake.margin_type = 'EXTEND'


def bake(kind, samples, **passes):
    img = bpy.data.images.new(kind, a.size, a.size, float_buffer=True, alpha=False)
    for slot in room.material_slots:
        nt = slot.material.node_tree
        node = nt.nodes.new('ShaderNodeTexImage')
        node.name = 'bake-target'
        node.image = img
        nt.nodes.active = node
    room.data.uv_layers.active = room.data.uv_layers['LightMap']
    bpy.ops.object.select_all(action='DESELECT')
    room.select_set(True)
    bpy.context.view_layer.objects.active = room
    scene.cycles.samples = samples
    for k, v in passes.items():
        setattr(scene.render.bake, k, v)
    bpy.ops.object.bake(type=kind)
    for slot in room.material_slots:
        nt = slot.material.node_tree
        nt.nodes.remove(nt.nodes['bake-target'])
    px = np.array(img.pixels[:], dtype=np.float32).reshape(a.size, a.size, 4)[::-1, :, :3]  # PNG rows run top down
    return px


def blur(px, sigma):
    """A small Gaussian blur, which smooths the bake's noise. It stays inside each part's patch, because
    the patches are packed apart and the bake's margin fills the gaps between them."""
    r = int(3 * sigma + 0.5)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        px = np.apply_along_axis(lambda v: np.convolve(np.pad(v, r, mode='edge'), k, mode='valid'), axis, px)
    return px


light = blur(bake('DIFFUSE', a.samples, use_pass_direct=False, use_pass_indirect=True, use_pass_color=False), 1.5)
ao = blur(bake('AO', a.ao_samples), 0.8)

# The light can be brighter than 1, so the PNG holds light / scale, and the page multiplies back.
scale = float(max(1.0, np.percentile(light, 99.7)))
srgb = np.clip(light / scale, 0, 1)
srgb = np.where(srgb <= 0.0031308, srgb * 12.92, 1.055 * np.power(srgb, 1 / 2.4) - 0.055)
Image.fromarray((srgb * 255 + 0.5).astype(np.uint8), 'RGB').save(os.path.join(a.out, 'light.png'), optimize=True)
Image.fromarray((np.clip(ao[:, :, 0], 0, 1) * 255 + 0.5).astype(np.uint8), 'L').save(os.path.join(a.out, 'ao.png'), optimize=True)

# ---------- the joined mesh, with both UV sets and the material names, no images ----------
room.data.uv_layers.active = room.data.uv_layers[0]
bpy.ops.object.select_all(action='DESELECT')
room.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(a.out, 'room.glb'), export_format='GLB', use_selection=True,
                          export_texcoords=True, export_normals=True, export_materials='EXPORT',
                          export_image_format='NONE', export_lights=False, export_cameras=False)

bake_json = {
    'about': 'Written by office/baked/bake.py. See office/baked/README.md.',
    'part': info['part'],
    'sun': info['sun'],
    'lightMapIntensity': round(scale, 4),
    'aoMapIntensity': 1.0,
    'ambientScale': 0.2,
    'keys': info['keys'],
}
json.dump(bake_json, open(os.path.join(a.out, 'bake.json'), 'w'), indent=1)
print('light scale', scale, 'size', a.size)
