"""Bounded beat and key analysis. Uncertain measurements stay unknown."""
import json
import sys

# Pitch classes are C through B; enharmonic spellings share a Camelot slot.
CAMELOT = {
    'major': ('8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'),
    'minor': ('5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'),
}
PITCH_NAMES = ('C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')
KEY_PROFILES = {
    'major': (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88),
    'minor': (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17),
}


def detect_key(chroma):
    """Krumhansl-Schmuckler correlation with an absolute and runner-up margin."""
    import numpy as np
    chroma = np.asarray(chroma, dtype=float)
    if chroma.shape != (12,) or not np.isfinite(chroma).all() or np.std(chroma) < 1e-6:
        return {}
    scores = sorted((float(np.corrcoef(chroma, np.roll(profile, pitch))[0, 1]), mode, pitch)
                    for mode, profile in KEY_PROFILES.items() for pitch in range(12))
    score, mode, pitch = scores[-1]
    # These are conservative evidence thresholds, not calibrated probabilities.
    if score < .7 or score - scores[-2][0] < .06:
        return {}
    return {'key': CAMELOT[mode][pitch], 'key_name': PITCH_NAMES[pitch] + ' ' + mode}


def mean_chroma(samples, sr):
    import librosa
    import numpy as np
    samples = np.asarray(samples, dtype=np.float32)
    if len(samples) < 4096 or np.max(np.abs(samples)) < 1e-5:
        return np.zeros(12)
    return librosa.feature.chroma_stft(y=samples, sr=sr, n_fft=4096,
                                       hop_length=1024, tuning=0).mean(axis=1)


def analyze(samples, sr=22050):
    import librosa
    import numpy as np
    # Smaller float32 spectra bound each 30-second worker window's allocation.
    samples = np.asarray(samples, dtype=np.float32)
    onset = librosa.onset.onset_strength(y=samples, sr=sr, hop_length=256, n_fft=1024, n_mels=64)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=256, trim=True)
    beats = librosa.frames_to_time(frames, sr=sr, hop_length=256)
    if len(beats) < 12:
        return {"reliable": False, "reason": "Too few detected beats"}
    intervals = np.diff(beats)
    period = float(np.median(intervals))
    spread = float(np.quantile(np.abs(intervals - period), .9) / period)
    locations = np.minimum(frames, len(onset) - 1)
    support = float(np.mean(onset[locations] >= .25 * max(float(np.max(onset)), 1e-9)))
    observed = librosa.onset.onset_detect(onset_envelope=onset, sr=sr, hop_length=256, units="time")
    if len(observed):
        indexes = np.searchsorted(observed, beats)
        before = observed[np.clip(indexes - 1, 0, len(observed) - 1)]
        after = observed[np.clip(indexes, 0, len(observed) - 1)]
        phase_error = float(np.quantile(np.minimum(np.abs(beats - before), np.abs(beats - after)), .9) / period)
    else:
        phase_error = 1
    # A conservative measured stability/support score, not a calibrated probability.
    confidence = max(0, min(1, (1 - spread * 5) * support * max(0, 1 - phase_error)))
    return {"bpm": 60 / period, "beats": beats.tolist(), "confidence": confidence,
            "variation": spread, "phase_error": phase_error, "reliable": confidence >= .7 and spread <= .06 and phase_error <= .12,
            "reason": "Beat grid only; phrase and downbeat are unknown"}


def analyze_file(path):
    import soundfile as sf
    import numpy as np
    windows, beats = [], []
    with sf.SoundFile(path) as source:
        sr = source.samplerate
        for i, samples in enumerate(source.blocks(blocksize=sr * 30, dtype="float32")):
            if len(samples) < sr * 8:
                break
            result = analyze(samples, sr)
            windows.append(result)
            beats.extend(b + i * 30 for b in result.get("beats", []))
    if not windows or any("bpm" not in w for w in windows):
        return {"reliable": False, "reason": "Too few detected beats"}
    bpm = float(np.median([w["bpm"] for w in windows]))
    variation = max(abs(w["bpm"] / bpm - 1) for w in windows)
    return {"bpm": bpm, "beats": beats, "confidence": min(w["confidence"] for w in windows),
            "variation": variation, "reliable": variation <= .06 and all(w["reliable"] for w in windows),
            "reason": "Thirty-second grids; phrase and downbeat are unknown"}


def analyze_library(path, duration, ffmpeg='ffmpeg'):
    """Decode at most three 30 s mono windows, independent of recording length."""
    import math
    import subprocess
    import numpy as np
    if not math.isfinite(duration) or duration < 8:
        return {}
    length = min(30, duration)
    starts = sorted({round(max(0, duration - length) * fraction, 3) for fraction in (.2, .5, .8)})
    windows, chromas = [], []
    for start in starts:
        decoded = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-threads', '1',
            '-filter_threads', '1', '-filter_complex_threads', '1',
            '-protocol_whitelist', 'file,pipe', '-ss', str(start), '-i', str(path),
            '-map', '0:a:0', '-t', str(length), '-ac', '1', '-ar', '22050', '-f', 'f32le', '-threads', '1', 'pipe:1'],
            capture_output=True, check=True, timeout=45)
        samples = np.frombuffer(decoded.stdout, dtype='<f4')
        if len(samples) < 22050 * 8:
            return {}
        windows.append(analyze(samples))
        chromas.append(mean_chroma(samples, 22050))
    result = detect_key(np.mean(chromas, axis=0))
    # A modulation must not acquire a global key: a window with a different confident key
    # rules it out; a window without a clear key does not.
    if result and any(detect_key(chroma).get('key') not in (None, result['key']) for chroma in chromas):
        result = {}
    bpm = library_bpm(windows)
    if bpm: result['bpm'] = bpm
    return result


def library_bpm(windows, minimum_confidence=.1, tolerance=.04):
    """Tempo for the library: the transition analysis never marks a grid reliable without
    downbeats, so use windows with some beat support and require at least two to agree.
    Half and double time count as agreement; anything else leaves the BPM unknown."""
    support = lambda w: w.get('confidence', 1 if w.get('reliable') else 0)
    usable = sorted((w for w in windows if isinstance(w.get('bpm'), (int, float)) and w['bpm'] > 0
                     and support(w) >= minimum_confidence), key=lambda w: -support(w))
    if len(usable) < 2:
        return None
    reference = usable[0]['bpm']
    folded = [min((w['bpm'] * f for f in (.5, 1, 2)), key=lambda v: abs(v / reference - 1)) for w in usable]
    if max(abs(v / reference - 1) for v in folded) > tolerance:
        return None
    import statistics
    return round(statistics.median(folded))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == '--library':
        print(json.dumps(analyze_library(sys.argv[2], float(sys.argv[3]), sys.argv[4])))
    else:
        print(json.dumps(analyze_file(sys.argv[1])))
