#!/usr/bin/env python3
"""Turn YouTube rolling auto-captions into one line at a time.

YouTube's SRT keeps each line on screen until the line after next starts, so two lines overlap and the older one
lingers (bottom, then top, alternating), and ">>" marks a change of speaker. Each cue here ends when the next begins, or after a reading time.
Usage: clean-rolling-captions.py input.srt output.srt
"""
import pathlib, re, sys

def seconds(stamp):
    h, m, rest = stamp.split(':'); s, ms = rest.split(',')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

def stamp(value):
    ms = round(value * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"

def clean(text):
    cues = []
    for block in re.split(r'\n\s*\n', text.strip()):
        lines = block.split('\n')
        match = re.match(r'(\S+) --> (\S+)', lines[1])
        line = ' '.join(l.strip() for l in lines[2:]).strip()
        line = re.sub(r'^(?:>>|&gt;&gt;)\s*', '', line)  # YouTube's speaker-change mark
        cues.append([seconds(match.group(1)), seconds(match.group(2)), line])
    cues.sort(key=lambda cue: cue[0])
    out = []
    for i, (start, end, line) in enumerate(cues):
        following = cues[i + 1][0] if i + 1 < len(cues) else end
        reading = min(7.0, max(1.6, 0.065 * len(line) + 1.2))
        stop = min(end, following - 0.04 if following > start + 0.2 else end, start + reading)
        out.append(f"{i + 1}\n{stamp(start)} --> {stamp(max(stop, start + 0.8))}\n{line}\n")
    return '\n'.join(out)

if __name__ == '__main__':
    source, target = map(pathlib.Path, sys.argv[1:3])
    target.write_text(clean(source.read_text(encoding='utf-8')), encoding='utf-8')
