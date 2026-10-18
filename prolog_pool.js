const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const MAX_QUEUED_JOBS = 1000;
const JOB_TIMEOUT_MS = 30000;
const IDLE_WORKER_TIMEOUT_MS = 1000;
const CPU_COUNT = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
const WORKER_COUNT = Math.max(1, Math.min(4, CPU_COUNT - 1));

class PrologWorkerPool {
    constructor(size) {
        this.queue = [];
        this.nextJobId = 1;
        this.slots = Array.from({ length: size }, () => ({
            worker: null,
            job: null,
            idleTimer: null,
            replacing: false
        }));
        this.closed = false;
        this.slots.forEach(slot => this.startWorker(slot));
    }

    run(program, query, variables) {
        if (this.closed) return Promise.reject(new Error('Prolog worker pool is closed.'));
        if (this.queue.length >= MAX_QUEUED_JOBS) {
            return Promise.reject(new Error('Prolog worker queue is full; retry the request shortly.'));
        }

        return new Promise((resolve, reject) => {
            this.queue.push({
                jobId: this.nextJobId++,
                program,
                query,
                variables,
                resolve,
                reject,
                timeout: null
            });
            this.dispatch();
        });
    }

    startWorker(slot) {
        if (this.closed) return;
        const worker = new Worker(path.join(__dirname, 'prolog_worker.js'));
        slot.worker = worker;
        slot.replacing = false;
        worker.on('message', message => this.handleMessage(slot, worker, message));
        worker.on('messageerror', error => this.replaceWorker(slot, worker, error));
        worker.on('error', error => this.replaceWorker(slot, worker, error));
        worker.on('exit', code => {
            if (slot.worker === worker && !this.closed) {
                this.replaceWorker(slot, worker, new Error(`Prolog worker exited unexpectedly (${code}).`));
            }
        });
        worker.unref();
    }

    dispatch() {
        if (this.closed) return;
        for (const slot of this.slots) {
            if (!this.queue.length) return;
            if (slot.replacing || slot.job) continue;
            if (!slot.worker) this.startWorker(slot);
            if (!slot.worker) continue;
            clearTimeout(slot.idleTimer);
            slot.idleTimer = null;
            const job = this.queue.shift();
            slot.job = job;
            const worker = slot.worker;
            worker.ref();
            job.timeout = setTimeout(() => {
                this.replaceWorker(slot, worker, new Error('Prolog evaluation timed out.'));
            }, JOB_TIMEOUT_MS);
            try {
                worker.postMessage({
                    jobId: job.jobId,
                    program: job.program,
                    query: job.query,
                    variables: job.variables
                });
            } catch (error) {
                this.replaceWorker(slot, slot.worker, error);
            }
        }
    }

    handleMessage(slot, worker, message) {
        if (slot.worker !== worker || !slot.job || message.jobId !== slot.job.jobId) return;
        const job = slot.job;
        clearTimeout(job.timeout);
        slot.job = null;
        worker.unref();
        if (message.error) job.reject(new Error(message.error));
        else job.resolve(message.bindings);
        slot.idleTimer = setTimeout(() => {
            if (slot.worker !== worker || slot.job || this.closed) return;
            slot.worker = null;
            worker.terminate();
        }, IDLE_WORKER_TIMEOUT_MS);
        this.dispatch();
    }

    replaceWorker(slot, worker, error) {
        if (slot.worker !== worker || slot.replacing) return;
        slot.replacing = true;
        clearTimeout(slot.idleTimer);
        slot.idleTimer = null;
        slot.worker = null;
        const job = slot.job;
        slot.job = null;
        if (job) {
            clearTimeout(job.timeout);
            job.reject(error instanceof Error ? error : new Error(String(error)));
        }
        worker.terminate().finally(() => {
            if (!this.closed) {
                this.startWorker(slot);
                this.dispatch();
            }
        });
    }

    close() {
        this.closed = true;
        for (const job of this.queue.splice(0)) {
            job.reject(new Error('Prolog worker pool is closed.'));
        }
        for (const slot of this.slots) {
            clearTimeout(slot.idleTimer);
            if (slot.job) {
                clearTimeout(slot.job.timeout);
                slot.job.reject(new Error('Prolog worker pool is closed.'));
                slot.job = null;
            }
            slot.worker?.terminate();
            slot.worker = null;
        }
    }
}

const prologPool = new PrologWorkerPool(WORKER_COUNT);

module.exports = {
    runProlog: (program, query, variables) => prologPool.run(program, query, variables),
    closePrologPool: () => prologPool.close()
};
