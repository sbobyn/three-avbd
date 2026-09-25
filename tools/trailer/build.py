# Cuts the recorded clips (clips/*.mp4, from shots.js) into the trailer: trims each shot,
# captions it with the numbers measured while it was recorded (clips/stats.json), and joins
# them. Needs ffmpeg with libfreetype. See README.md.
#
#   python3 tools/trailer/build.py [--machine "Apple M1 Pro"] [--out trailer.mp4]
import argparse, json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS = os.path.join(HERE, 'clips')
TXT = os.path.join(CLIPS, 'captions')
FONT = '/System/Library/Fonts/HelveticaNeue.ttc'
INK = '0x1f2328'
MUTED = '0x5b6168'
CARD = '0xfffdf9@0.86'

args = argparse.ArgumentParser()
args.add_argument('--machine', help='named in the corner tag, e.g. "Apple M1 Pro"')
args.add_argument('--out', default=os.path.join(HERE, 'avbd-trailer.mp4'))
args = args.parse_args()

stats = json.load(open(os.path.join(CLIPS, 'stats.json')))
shots = stats['shots']
missing = [n for n in ('ring', 'walls', 'breakable', 'rope', 'chain', 'springs', 'ragdolls', 'static', 'dynamic', 'flag', 'columns') if n not in shots]
if missing:
    sys.exit(f'not recorded yet: {", ".join(missing)} (run T.runAll in the page)')


def step(name):
    """The shot's measured time per step, e.g. '7.7 ms per step'."""
    m = re.match(r'([\d.]+)\s*ms', shots[name]['step'])
    return f'{m.group(1)} ms per step' if m else ''


def thousands(name):
    """The shot's body count to the nearest thousand, e.g. '110,000'."""
    return f"{round(shots[name]['bodies'], -3):,}"


# (clip, in, duration, [(caption, sub, from, to)])
SHOTS = [
    ('ring', 0.3, 3.6, [(f"{thousands('ring')} rigid bodies", step('ring'), 2.0, 3.6)]),
    ('walls', 0.3, 3.4, [('Cannonballs', 'size and mass set live', 0.0, 3.4)]),
    ('breakable', 0.5, 1.7, [('Breakable welds', '600 bricks', 0.0, 1.7)]),
    ('rope', 1.5, 2.2, [('Rope', 'grab anything', 0.0, 2.2)]),
    ('chain', 0.2, 1.5, [('Chain mail', '1,600 interlocked rings', 0.0, 1.5)]),
    ('springs', 1.3, 2.0, [('Springs', '1,000 : 1 stiffness ratio', 0.0, 2.0)]),
    ('ragdolls', 0.6, 1.7, [('Ragdolls on cloth', '24,000 bodies', 0.0, 1.7)]),
    ('static', 3.4, 1.6, [('Static friction', 'μ 0.25 to 0.5', 0.0, 1.6)]),
    ('dynamic', 0.1, 1.7, [('Dynamic friction', 'μ 0 to 5', 0.0, 1.7)]),
    ('flag', 0.5, 2.8, [('Wind', 'steered live', 0.0, 2.8)]),
    ('columns', 0.05, 5.8, [('Grab anything', '', 0.0, 1.6), (f"{thousands('columns')} bodies", step('columns'), 1.7, 5.8)]),
]
TAG = 'Recorded live in Chrome' + (f'  ·  {args.machine}' if args.machine else '')

# A shot under 60 fps ran its simulation slower than real time: say so before captioning it
slow = [f"{n} ({s['fps']} fps)" for n, s in shots.items() if s['fps'] < 58]
if slow:
    print('WARNING: below 60 fps, so slower than real time:', ', '.join(slow), file=sys.stderr)
    print('  re-record those on a quiet machine on AC power, or with a smaller scene', file=sys.stderr)

os.makedirs(TXT, exist_ok=True)


def text(name, s):
    path = os.path.join(TXT, f'{name}.txt')
    with open(path, 'w') as f:
        f.write(s)
    return path


def fade(t0, t1):
    return f"if(lt(t,{t0}),0,if(lt(t,{t0 + 0.2}),(t-{t0})/0.2,if(lt(t,{t1 - 0.15}),1,max(0,({t1}-t)/0.15))))"


def draw(name, s, x, y, size, t0, t1, color=INK):
    opts = [f"fontfile='{FONT}'", f"textfile='{text(name, s)}'", f'fontsize={size}', f'fontcolor={color}', f'x={x}', f'y={y}', f"alpha='{fade(t0, t1)}'"]
    opts += ['box=1', f'boxcolor={CARD}', 'boxborderw=18|26']
    return 'drawtext=' + ':'.join(opts)


inputs, chains, labels = [], [], []
for i, (clip, start, dur, caps) in enumerate(SHOTS):
    inputs += ['-ss', str(start), '-t', str(dur), '-i', os.path.join(CLIPS, f'{clip}.mp4')]
    f = [f'[{i}:v]fps=60,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS']
    for j, (cap, sub, t0, t1) in enumerate(caps):
        # The last caption holds to the final frame
        if i == len(SHOTS) - 1 and j == len(caps) - 1:
            t1 = dur + 1
        f.append(draw(f'{clip}{j}', f'{cap}  ·  {sub}' if sub else cap, 90, 'h-150', 40, t0, t1))
    if clip == 'ring':
        # Opening title over the smash
        f.append(draw('title', 'Augmented Vertex Block Descent', 90, 90, 64, -1, 2.1))
        f.append(draw('title2', 'real time, in the browser, on WebGPU', 90, 196, 36, -1, 2.1, color=MUTED))
    f.append(draw(f'{clip}live', TAG, 'w-tw-72', 64, 26, -1, dur + 1, color=MUTED))
    chains.append(','.join(f) + f'[v{i}]')
    labels.append(f'[v{i}]')

graph = ';'.join(chains) + ';' + ''.join(labels) + f'concat=n={len(SHOTS)}:v=1:a=0,format=yuv420p[out]'
cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high', '-movflags', '+faststart', '-r', '60', args.out]
subprocess.run(cmd, check=True)
print(args.out)
