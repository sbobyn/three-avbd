# Cuts the Starry Night clip (clips/starry.mp4, from shots.js S.starry) for posting: a square
# crop on the painting, a hook at the start and the trick explained over the finished picture.
#
#   python3 tools/trailer/starry.py [--machine "Apple M4 Max"] [--out starry-night.mp4]
import argparse, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
CLIPS = os.path.join(HERE, 'clips')
TXT = os.path.join(CLIPS, 'captions')
FONT = '/System/Library/Fonts/HelveticaNeue.ttc'
INK = '0x1f2328'
MUTED = '0x5b6168'
CARD = '0xfffdf9@0.86'

args = argparse.ArgumentParser()
args.add_argument('--machine', help='named in the corner tag')
args.add_argument('--out', default=os.path.join(HERE, 'starry-night.mp4'))
args = args.parse_args()
os.makedirs(TXT, exist_ok=True)


def text(name, s):
    path = os.path.join(TXT, f'{name}.txt')
    with open(path, 'w') as f:
        f.write(s)
    return path


def fade(t0, t1):
    return f"if(lt(t,{t0}),0,if(lt(t,{t0 + 0.3}),(t-{t0})/0.3,if(lt(t,{t1 - 0.3}),1,max(0,({t1}-t)/0.3))))"


def draw(name, s, x, y, size, t0, t1, color=INK):
    pad = round(size * 0.42)
    return 'drawtext=' + ':'.join([
        f"fontfile='{FONT}'", f"textfile='{text(name, s)}'", f'fontsize={size}', f'fontcolor={color}', f'x={x}', f'y={y}',
        f"alpha='{fade(t0, t1)}'", 'box=1', f'boxcolor={CARD}', f'boxborderw={pad}|{round(pad * 1.4)}',
    ])


# (text, x, y, size, from, to, colour)
CAPTIONS = [
    ('20,000 spheres, poured in at random', '(w-tw)/2', 60, 46, 0.2, 4.2, INK),
    ('How do they know where to land?', '(w-tw)/2', 60, 46, 9.0, 13.0, INK),
]
TAG = 'Recorded live in Chrome, real time' + (f'  ·  {args.machine}' if args.machine else '')

f = ['fps=60', 'crop=1080:1080:420:0', 'setsar=1']
for i, (s, x, y, size, t0, t1, color) in enumerate(CAPTIONS):
    f.append(draw(f'starry{i}', s, x, y, size, t0, t1, color))
f.append(draw('starrytag', TAG, 'w-tw-48', 'h-62', 22, -1, 40, MUTED))
cmd = ['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(CLIPS, 'starry.mp4'), '-t', '31', '-vf', ','.join(f),
       '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '60', args.out]
subprocess.run(cmd, check=True)
print(args.out)
