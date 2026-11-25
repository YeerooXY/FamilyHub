# Library index benchmark

The benchmark uses local temporary workspaces with small manifests and no audio. The scan reads every manifest using the same folder enumeration as the fallback route. Audio hashing, HTTP serialization and compression, and operating-system cache flushing are outside this measurement. Startup opens a fresh index instance and reads its marker. Startup and query times are medians of 31 runs. Scan and build are timed once per size.

| Songs | Scan (ms) | Build (ms) | Startup (ms) | ID lookup (ms) | Selective search (ms) | Broad search (ms) | First page (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 5,993.116 | 346.910 | 1.080 | 1.144 | 6.198 | 2.879 | 1.228 |
| 12,000 | 32,745.313 | 1,944.504 | 1.113 | 1.063 | 18.326 | 8.883 | 1.221 |
| 50,000 | 147,528.630 | 8,752.790 | 1.070 | 1.161 | 63.023 | 31.159 | 1.193 |

50,000 versus 2,000 songs. ID lookup 1.01×, Selective search 10.17×, Broad search 10.82×, First page 0.97×.
