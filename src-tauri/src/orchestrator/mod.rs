//! Orchestrator — dispatch, per-session task queues, and heartbeat types.
//!
//! The queue/dispatch *decision* logic here is pure and unit-tested; the actual
//! prompt execution and event emission live in the Tauri service layer, and the
//! periodic heartbeat loop is spawned at app setup.

use std::collections::VecDeque;

use serde::Serialize;

pub mod schedule;

/// A session is dispatchable now iff it is idle and has queued work.
pub fn dispatchable(busy: bool, queue_len: usize) -> bool {
    !busy && queue_len > 0
}

/// A FIFO task queue with a busy flag, tracking one session's pending prompts.
#[derive(Debug, Default)]
pub struct TaskQueue {
    tasks: VecDeque<String>,
    pub busy: bool,
}

impl TaskQueue {
    pub fn enqueue(&mut self, task: String) {
        self.tasks.push_back(task);
    }

    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty()
    }

    /// Peek the next task without removing it (for dry-run preview).
    pub fn peek(&self) -> Option<&String> {
        self.tasks.front()
    }

    /// Take the next task iff idle; marks busy. Returns None if busy/empty.
    pub fn take_next(&mut self) -> Option<String> {
        if self.busy || self.tasks.is_empty() {
            return None;
        }
        let task = self.tasks.pop_front();
        if task.is_some() {
            self.busy = true;
        }
        task
    }

    /// Mark the current turn finished (idle again).
    pub fn finish(&mut self) {
        self.busy = false;
    }
}

/// What a heartbeat pass did (or would do, for a dry run).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatReport {
    pub ts: String,
    pub dry_run: bool,
    /// Sessions a task was (or would be) dispatched to this pass.
    pub dispatched: Vec<Dispatched>,
    /// Total tasks still queued across all sessions after the pass.
    pub queued_remaining: usize,
}

/// One dispatch performed (or previewed) in a heartbeat pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatched {
    pub session_id: String,
    pub task: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatchable_only_when_idle_with_work() {
        assert!(dispatchable(false, 1));
        assert!(!dispatchable(true, 1)); // busy
        assert!(!dispatchable(false, 0)); // empty
        assert!(!dispatchable(true, 0));
    }

    #[test]
    fn queue_is_fifo_and_respects_busy() {
        let mut q = TaskQueue::default();
        q.enqueue("a".into());
        q.enqueue("b".into());
        assert_eq!(q.len(), 2);
        assert_eq!(q.peek(), Some(&"a".to_string()));

        // Take marks busy and pops FIFO.
        assert_eq!(q.take_next(), Some("a".into()));
        assert!(q.busy);
        // Busy → no further dispatch even though "b" is queued.
        assert_eq!(q.take_next(), None);

        // Finish → idle → next task dispatchable.
        q.finish();
        assert!(!q.busy);
        assert_eq!(q.take_next(), Some("b".into()));
        assert!(q.busy);

        q.finish();
        assert_eq!(q.take_next(), None); // empty
        assert!(!q.busy);
    }

    #[test]
    fn empty_take_does_not_mark_busy() {
        let mut q = TaskQueue::default();
        assert_eq!(q.take_next(), None);
        assert!(!q.busy);
    }
}
