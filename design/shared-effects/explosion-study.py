import bpy, math, random
from pathlib import Path
rng=random.Random(47)
scene=bpy.data.scenes.new('SharedFX_Explosion_Study')
bpy.context.window.scene=scene
scene.render.engine='BLENDER_EEVEE'
scene.render.resolution_x=768;scene.render.resolution_y=512;scene.render.resolution_percentage=100
scene.render.film_transparent=True
scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA'
scene.world=bpy.data.worlds.new('SharedFX_DarkWorld');scene.world.use_nodes=True
scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.02
scene.view_settings.view_transform='AgX'
scene.render.fps=30;scene.frame_end=45
cam=bpy.data.objects.new('SharedFX_Camera',bpy.data.cameras.new('SharedFX_Camera'))
scene.collection.objects.link(cam);cam.location=(0,0,11);cam.data.type='ORTHO';cam.data.ortho_scale=10.5;scene.camera=cam

def volume(name, fire):
 m=bpy.data.materials.new(name);m.use_nodes=True;n=m.node_tree.nodes;l=m.node_tree.links;n.clear()
 out=n.new('ShaderNodeOutputMaterial');v=n.new('ShaderNodeVolumePrincipled');l.new(v.outputs['Volume'],out.inputs['Volume'])
 tex=n.new('ShaderNodeTexCoord');noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=4.5;noise.inputs['Detail'].default_value=4;noise.inputs['Roughness'].default_value=.7;l.new(tex.outputs['Generated'],noise.inputs['Vector'])
 sub=n.new('ShaderNodeVectorMath');sub.operation='SUBTRACT';sub.inputs[1].default_value=(.5,.5,.5);l.new(tex.outputs['Generated'],sub.inputs[0])
 length=n.new('ShaderNodeVectorMath');length.operation='LENGTH';l.new(sub.outputs['Vector'],length.inputs[0])
 edge=n.new('ShaderNodeMapRange');edge.inputs['From Min'].default_value=.18;edge.inputs['From Max'].default_value=.5;edge.inputs['To Min'].default_value=1;edge.inputs['To Max'].default_value=0;l.new(length.outputs['Value'],edge.inputs['Value'])
 mul=n.new('ShaderNodeMath');mul.operation='MULTIPLY';l.new(noise.outputs['Fac'],mul.inputs[0]);l.new(edge.outputs['Result'],mul.inputs[1])
 den=n.new('ShaderNodeMath');den.operation='MULTIPLY';den.inputs[1].default_value=4 if fire else 2.2;l.new(mul.outputs[0],den.inputs[0]);l.new(den.outputs[0],v.inputs['Density'])
 v.inputs['Color'].default_value=(.16,.07,.04,1) if fire else (.12,.13,.16,1)
 v.inputs['Anisotropy'].default_value=.2
 if fire:
  ramp=n.new('ShaderNodeValToRGB');ramp.color_ramp.elements.remove(ramp.color_ramp.elements[1]);ramp.color_ramp.elements[0].position=.15;ramp.color_ramp.elements[0].color=(.3,.012,.001,1)
  for pos,col in [(.42,(1,.11,.005,1)),(.6,(1,.5,.05,1)),(.78,(1,.9,.5,1))]:ramp.color_ramp.elements.new(pos).color=col
  l.new(noise.outputs['Fac'],ramp.inputs[0]);l.new(ramp.outputs['Color'],v.inputs['Emission Color'])
  glow=n.new('ShaderNodeMath');glow.operation='MULTIPLY';glow.inputs[1].default_value=5;l.new(mul.outputs[0],glow.inputs[0]);l.new(glow.outputs[0],v.inputs['Emission Strength'])
 return m
fire=volume('SharedFX_TurbulentFire',True);smoke=volume('SharedFX_SoftSmoke',False)
for i in range(27):
 a=rng.uniform(0,math.tau);dist=rng.uniform(.15,1.65);size=rng.uniform(.55,1.05)
 bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1,location=(math.cos(a)*dist,math.sin(a)*dist*.7,rng.uniform(-.5,.35)))
 ob=bpy.context.object;ob.name=f'SharedFX_Billow_{i:02}';ob.data.materials.append(fire if i<18 else smoke)
 destination=ob.location.copy();ob.scale=(.03,)*3;ob.location=(0,0,0);ob.keyframe_insert('scale',frame=1);ob.keyframe_insert('location',frame=1)
 ob.location=destination;ob.scale=(size,size*rng.uniform(.7,1.15),size);ob.keyframe_insert('scale',frame=16);ob.keyframe_insert('location',frame=16)
 ob.location*=1.7;ob.scale*=1.3;ob.keyframe_insert('scale',frame=32);ob.keyframe_insert('location',frame=32)
 ob.scale=(0,0,0);ob.keyframe_insert('scale',frame=45)
# Small hot fragments with a brief outward trail; geometry remains editable.
mat=bpy.data.materials.new('SharedFX_Ember');mat.use_nodes=True;bs=mat.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(1,.25,.025,1);bs.inputs['Emission Color'].default_value=(1,.28,.035,1);bs.inputs['Emission Strength'].default_value=8
for i in range(80):
 a=rng.uniform(0,math.tau);d=rng.uniform(1.4,4.1)
 bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=rng.uniform(.008,.023),location=(math.cos(a)*d,math.sin(a)*d*.62,rng.uniform(-.5,.7)))
 ob=bpy.context.object;ob.name=f'SharedFX_Ember_{i:02}';ob.data.materials.append(mat);ob.scale=(1,1,rng.uniform(1,2))
# Glare compositing keeps the authored image transparent.
tree=bpy.data.node_groups.new('SharedFX_Glow','CompositorNodeTree');tree.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor')
rl=tree.nodes.new('CompositorNodeRLayers');rl.scene=scene;gl=tree.nodes.new('CompositorNodeGlare');gl.inputs['Type'].default_value='Fog Glow';gl.inputs['Quality'].default_value='High'
out=tree.nodes.new('NodeGroupOutput');tree.links.new(rl.outputs['Image'],gl.inputs['Image']);tree.links.new(gl.outputs['Image'],out.inputs['Image']);scene.compositing_node_group=tree
scene.frame_set(16)
scene.render.filepath='C:/Users/you/Projects/FamilyHub/.local/effects-preview/explosion-study.png'
bpy.ops.wm.save_as_mainfile(filepath='C:/Users/you/Projects/FamilyHub/design/shared-effects/explosion-study.blend')
print('Created editable explosion study:',len(scene.objects),'objects')
bpy.ops.render.render(write_still=True)
print('Rendered',scene.render.filepath)
