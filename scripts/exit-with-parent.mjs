// Loaded with `node --import` into the build and each instance that `npm run dev:local` starts
// (scripts/dev-local.mts): this process ends when that script is gone, however it ended. On
// Windows ending a process does not end its children, so without this a terminal closed without
// Ctrl+C left the build and every instance running, each one more per restart.
const parent = Number(process.env.DEV_LOCAL_PID);
if (parent) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (err) {
      // ESRCH: no such process. EPERM means it exists (another user's): keep running.
      if (err && err.code === 'ESRCH') process.exit(0);
    }
  }, 2000).unref();
}
