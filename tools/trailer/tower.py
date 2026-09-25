# Cuts the Mona Lisa Tower clip (clips/tower.mp4, from shots.js S.tower) for posting: full
# frame, no text.
#
#   python3 tools/trailer/tower.py [--out mona-lisa-tower.mp4]
import argparse, os, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
args = argparse.ArgumentParser()
args.add_argument('--out', default=os.path.join(HERE, 'mona-lisa-tower.mp4'))
args = args.parse_args()
cmd = ['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(HERE, 'clips', 'tower.mp4'), '-t', '20.8', '-vf', 'fps=60,setsar=1',
       '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', '60', args.out]
subprocess.run(cmd, check=True)
print(args.out)
