# BridgeTunes Load Test Results

**Recorded:** 2026-10-20  
**Target:** `https://bridgetunes.onrender.com/api/playlists/8ea55f9435b344b3`  
**Test:** k6 `api/loadtest.js`, repeated GET requests for one ready playlist. The script uses constant virtual users; each iteration waits one second after its request.

## Completed runs

| Virtual users | Duration | Requests | Throughput | Average | Median | p90 | p95 | Maximum | Failed requests |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 2 min | 823 | 6.79 req/s | 456.82 ms | 108.07 ms | 347.41 ms | 385.74 ms | 25.13 s | 0 (0%) |
| 25 | 2 min | 2,696 | 22.26 req/s | 113.41 ms | 102.71 ms | 132.57 ms | 157.93 ms | 640.93 ms | 0 (0%) |
| 100 | 2 min | 10,428 | 86.00 req/s | 140.52 ms | 106.41 ms | 157.99 ms | 244.52 ms | 3.38 s | 0 (0%) |
| 100 | 5 min | 25,904 | 85.83 req/s | 155.05 ms | 103.79 ms | 336.02 ms | 354.51 ms | 7.24 s | 0 (0%) |
| 200 | 2 min | 16,004 | 132.12 req/s | 491.66 ms | 106.92 ms | 203.65 ms | 418.63 ms | 30.31 s | 171 (1.06%) |

The 10-, 25-, and both 100-VU runs passed the configured thresholds (`p95 < 2 s`, failures `< 1%`). The 200-VU run met the latency threshold but exceeded the error-rate threshold (`1.06%` versus `< 1%`); k6 reported 15,833 of 16,004 checks passing (98.93%).

## Interrupted run

A separate 50-VU, 2-minute run was manually interrupted after about 23 seconds. k6 reported 1,100 completed and 50 interrupted iterations. It is not included in the completed-run comparison.

## Interpretation and limits

- These results measure repeated reads of **one ready playlist** through the deployed Render API. They do not measure playlist creation, background matching, queue capacity, or actual human visitors.
- Repeated ready-playlist GETs primarily exercise the API’s short-lived in-process playlist cache. This workload does not meaningfully measure Upstash Redis or the QStash worker queue.

## Resume-safe summary

> Load-tested BridgeTunes’ ready-playlist API at 100 concurrent virtual users, sustaining 85.8 requests/sec across 25.9K requests with 0% request failures and 355 ms p95 latency.

This statement applies only to the read workload and test environment described above; it is not a claim about import or migration capacity.
