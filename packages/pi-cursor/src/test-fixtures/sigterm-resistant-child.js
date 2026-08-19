// Startup-cleanup integration fixture: a child that ignores SIGTERM, keeps
// stderr open, and never prints the stdout ready line. The real-child test
// in proxy-lifecycle.test.ts uses it to verify that a failed proxy startup
// escalates to SIGKILL and disposes every pipe.

// Install the SIGTERM handler first: the fixture announces itself on stderr
// only after this handler exists, so the test knows SIGTERM will be ignored.
process.on('SIGTERM', () => {
  process.stderr.write('[fixture] ignoring SIGTERM\n')
})
process.stderr.write('[fixture] started\n')
// Hold the process open; stderr stays open and stdout stays silent.
setInterval(() => {}, 60_000)
