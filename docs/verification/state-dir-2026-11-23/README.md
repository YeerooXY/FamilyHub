# State directory verification

## Local results

All changed Python files compiled. A single below-normal-priority Windows
process ran 52 dependency-free tests. 51 passed and one symlink test skipped
because the local Windows account could not create symlinks. The run loaded
the modules directly because the local Python environment lacks Flask.

The run covered state path defaults, migration and archive recovery, invalid
JSON handling, backup of a live WAL database, 14-copy retention, legacy audio
stamp conversion, edits in all three sampled regions, listening statistics
journal replay and subscription savings, upstream Wordle response validation,
and music intake input, manifest and search ranking checks.

## VM verification

From the repository root, use the project's VM virtual environment. Run the
suite headlessly at low priority. Unittest runs the test cases sequentially.

```sh
PYTHONPATH=tests nice -n 10 ionice -c 3 venv/bin/python -m unittest \
  tests.test_state_dir tests.test_state_cache tests.test_verified_hashes \
  tests.test_wordle tests.test_family_profiles tests.test_playback_resume \
  tests.test_listening_stats tests.test_current_song_activity \
  tests.test_listening_history_api tests.test_http_dispatch tests.test_priority_regressions
```

The new Flask regressions inject six-second disk stalls. They check Wordle,
Connect, preferences, saved playback and listening statistics reads against a
100 ms warm-read budget. They also force the stalled write to fail once and
verify that the successful retry survives a restart.

The Flask and Waitress suites, Linux I/O priority and service shutdown, and a
real disk migration were outside the local run. The checks used temporary
data and had no production-server access.
