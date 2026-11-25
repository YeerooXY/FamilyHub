namespace FamilyHub.Client.Core;

public sealed class ViewHistory<T> where T : notnull
{
    private readonly Stack<T> back = new(), forward = new();

    public bool CanBack => back.Count > 0;
    public bool CanForward => forward.Count > 0;

    public void Visit(T current, T destination)
    {
        if (EqualityComparer<T>.Default.Equals(current, destination)) return;
        back.Push(current);
        forward.Clear();
    }

    public void LeaveDetail(T current, T destination)
    {
        if (back.TryPeek(out var previous) && EqualityComparer<T>.Default.Equals(previous, destination))
            TryBack(current, out _);
        else
            Visit(current, destination);
    }

    public bool TryBack(T current, out T destination) => Step(back, forward, current, out destination);
    public bool TryForward(T current, out T destination) => Step(forward, back, current, out destination);

    private static bool Step(Stack<T> from, Stack<T> to, T current, out T destination)
    {
        if (!from.TryPop(out destination!)) return false;
        to.Push(current);
        return true;
    }

    public void Clear()
    {
        back.Clear();
        forward.Clear();
    }
}
