"""Measured beat-pair selection for the connected two-deck player."""
def transition(left, right, duration, fade, dj=False, current_rate=1, left_audio=None, right_audio=None):
    start = (right_audio or {}).get("start", 0)
    duration = (left_audio or {}).get("end", duration)
    fade = min(max(float(fade), 0), 12, duration / 3)
    plan = {"out": max(0, duration - fade * current_rate), "in": start, "rate": 1, "fade": fade, "mode": "Crossfade"}
    if not dj or not left.get("reliable") or not right.get("reliable"):
        return plan
    ratio = left["bpm"] * current_rate / right["bpm"]
    if not .94 <= ratio <= 1.06 or not fade:
        return plan
    outgoing = [b for b in left["beats"] if plan["out"] - .6 <= b <= plan["out"]]
    incoming = [b for b in right["beats"] if start <= b < start + 4]
    if outgoing and incoming:
        plan.update(out=outgoing[-1], **{"in": incoming[0]}, rate=ratio, mode="Beat blend")
    return plan
