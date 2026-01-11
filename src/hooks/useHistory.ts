import { useState, useCallback } from 'react';

interface HistoryState<T> {
    past: T[];
    present: T;
    future: T[];
}

export function useHistory<T>(initialState: T) {
    const [history, setHistory] = useState<HistoryState<T>>({
        past: [],
        present: initialState,
        future: [],
    });

    const { past, present, future } = history;

    const canUndo = past.length > 0;
    const canRedo = future.length > 0;

    const undo = useCallback(() => {
        if (!canUndo) return;

        const previous = past[past.length - 1];
        const newPast = past.slice(0, past.length - 1);

        setHistory({
            past: newPast,
            present: previous,
            future: [present, ...future],
        });
    }, [canUndo, past, present, future]);

    const redo = useCallback(() => {
        if (!canRedo) return;

        const next = future[0];
        const newFuture = future.slice(1);

        setHistory({
            past: [...past, present],
            present: next,
            future: newFuture,
        });
    }, [canRedo, future, past, present]);

    const setState = useCallback(
        (newState: T, shouldCommit: boolean = true) => {
            if (newState === present) return;

            if (shouldCommit) {
                setHistory({
                    past: [...past, present],
                    present: newState,
                    future: [],
                });
            } else {
                setHistory((prev) => ({
                    ...prev,
                    present: newState,
                }));
            }
        },
        [past, present]
    );

    return {
        state: present,
        setState,
        undo,
        redo,
        canUndo,
        canRedo,
    };
}
