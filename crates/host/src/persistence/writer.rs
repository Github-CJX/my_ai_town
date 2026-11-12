//! 存盘线程：渲染村民记忆文件、编码、写入与投影都在这里做，模拟线程只交一份 [`SaveJob`]。
//! 事务、退出这类要“写成功才算数”的路径走 [`Saves::commit_now`]，只等这一次写完，
//! 其余每秒一次的周期存盘排队进这条线程，模拟循环不再被那几百毫秒堵住
//! （`host::persistence::AUTOSAVE_INTERVAL` 一到，客户端看到的就是“走一走顿一下”）。
use super::{SaveJob, SaveStore, AUTOSAVE_INTERVAL};
use crate::{clock::ClockSave, HostError};
use std::{
    sync::{
        mpsc::{self, Receiver, Sender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

/// 一次存盘的结果：成功时带回这次落盘的时钟锚点，失败时带回错误（内存状态保留，下次再写）。
pub struct Written {
    /// 这一份的序号：比已经同步写进盘的那份旧的结果不再上报（那份状态已被更新的覆盖）。
    pub sequence: u64,
    pub clock: ClockSave,
    pub result: Result<(), HostError>,
}

/// 存档的写入端：一条线程，一个最多排一份的队列。模拟线程上的开销只剩世界快照、会话克隆与取事件。
pub struct Saves {
    store: Arc<Mutex<SaveStore>>,
    jobs: Option<Sender<SaveJob>>,
    done: Receiver<Written>,
    worker: Option<thread::JoinHandle<()>>,
    /// 有一份正在写：期间不再交新任务（存档只保留最新的一整份，不值得排队）。
    in_flight: bool,
    /// 上次交任务的时间；周期存盘按它节流。
    last_request: Option<Instant>,
    /// 交出去的份数，写进 [`SaveJob::sequence`]：先交后写的那份不会盖掉后写的新份。
    next_sequence: u64,
    /// 已经确认写进盘的最新序号（同步写成功时推进）：比它旧的结果不再上报，免得把时钟锚点倒退回去。
    committed: u64,
}

impl Saves {
    /// 接管一个已经打开并恢复过的存档。渲染、编码、写入、投影从此都在「存盘」线程上。
    pub fn open(store: SaveStore) -> Self {
        let store = Arc::new(Mutex::new(store));
        let (jobs, queue) = mpsc::channel::<SaveJob>();
        let (results, done) = mpsc::channel::<Written>();
        let writing = Arc::clone(&store);
        let worker = thread::Builder::new()
            .name("town-save".into())
            .spawn(move || {
                while let Ok(job) = queue.recv() {
                    let sequence = job.sequence;
                    let clock = job.clock.clone();
                    let result = match writing.lock() {
                        Ok(mut store) => store.commit(job).map(|_| ()),
                        Err(_) => Err(HostError::Save("存盘状态在别的线程上出了错".into())),
                    };
                    if results
                        .send(Written {
                            sequence,
                            clock,
                            result,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .expect("存盘线程起不来");
        Self {
            store,
            jobs: Some(jobs),
            done,
            worker: Some(worker),
            in_flight: false,
            last_request: None,
            next_sequence: 0,
            committed: 0,
        }
    }

    /// 该交下一份了吗：没有一份在写，而且距上次交够一个周期。
    pub fn due(&self) -> bool {
        !self.in_flight
            && self
                .last_request
                .is_none_or(|at| at.elapsed() >= AUTOSAVE_INTERVAL)
    }

    /// 交一份去写，不等结果；写完的结果从 [`Saves::poll`] 取。
    /// 有一份正在写时这次直接不算（那一份最多旧一拍，下一拍还会再交）：
    /// 调用方看到的 `Ok` 只表示“交出去了或已经有一份在写”，不是“写到盘上了”。
    pub fn submit(&mut self, mut job: SaveJob) -> Result<(), HostError> {
        if self.in_flight {
            return Ok(());
        }
        let Some(jobs) = &self.jobs else {
            return Err(HostError::Save("存盘线程已停止".into()));
        };
        job.sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        jobs.send(job)
            .map_err(|_| HostError::Save("存盘线程已停止".into()))?;
        self.in_flight = true;
        self.last_request = Some(Instant::now());
        Ok(())
    }

    /// 取走已经写完的结果；没有就空手回来。
    /// 比已经同步写进盘的那份旧的结果会被丢掉：盘上已经是更新的状态，再按它推进时钟锚点只会倒退。
    pub fn poll(&mut self) -> Vec<Written> {
        let mut written = Vec::new();
        loop {
            match self.done.try_recv() {
                Ok(result) => written.push(result),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        if !written.is_empty() {
            self.in_flight = false;
        }
        written.retain(|result| result.sequence >= self.committed);
        written
    }

    /// 同步写一份：等到这次真的落盘（事务回滚、退出、开工前的一次都用它）。
    /// 存盘线程手上那一份可能正在写，这里直接锁在同一个 [`SaveStore`] 上排队，
    /// 所以先交后写的那份不会盖掉这一份（顺序由 [`SaveJob::sequence`] 兜底）。
    pub fn commit_now(&mut self, mut job: SaveJob) -> Result<(), HostError> {
        if self.jobs.is_none() {
            return Err(HostError::Save("存盘线程已停止".into()));
        }
        job.sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        let sequence = job.sequence;
        let mut store = self
            .store
            .lock()
            .map_err(|_| HostError::Save("存盘状态在别的线程上出了错".into()))?;
        let result = store.commit(job).map(|_| ());
        if result.is_ok() {
            self.committed = self.committed.max(sequence);
        }
        result
    }
}

impl Drop for Saves {
    /// 关掉队列，让存盘线程把手上那一份写完再退出。
    fn drop(&mut self) {
        self.jobs = None;
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
