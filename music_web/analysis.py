"""Bounded beat analysis worker. No invented BPM, musical key or downbeats."""
import json
import sys


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


if __name__ == "__main__":
    print(json.dumps(analyze_file(sys.argv[1])))
