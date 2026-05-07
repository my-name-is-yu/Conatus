# Kaggle Experiment Contract

Workspace root:

```text
~/PulSeedWorkspaces/kaggle/<competition>/
  data/
  notebooks/
  src/
  experiments/
    <experiment_id>/
      config.json
      command.json
      process.json
      train.log
      metrics.json
      model.*
      submission.csv
      summary.md
  submissions/
```

Required per experiment:

- `config.json`: training configuration, seed, feature set, split policy.
- `command.json`: command, args, cwd, env keys, started timestamp.
- `process.json`: process session id, metadata path, running/exited status.
- `train.log`: durable training log written by the training command.
- `metrics.json`: strict validation metrics contract.

Minimum `metrics.json`:

```json
{
  "experiment_id": "exp-20260425-001",
  "competition": "titanic",
  "metric_name": "rmse",
  "direction": "minimize",
  "cv_score": 0.123,
  "cv_std": 0.004,
  "holdout_score": null,
  "train_rows": 1000,
  "valid_rows": 200,
  "seed": 42,
  "created_at": "2026-04-25T00:00:00.000Z",
  "status": "completed",
  "artifacts": {
    "model": "experiments/exp-20260425-001/model.pkl",
    "submission": "experiments/exp-20260425-001/submission.csv",
    "log": "experiments/exp-20260425-001/train.log"
  }
}
```

Wait and observe paths should use the returned absolute artifact paths or workspace-scoped references such as `workspace:kaggle/<competition>/experiments/<experiment_id>/metrics.json`. Runtime metadata and normalized artifacts may still be written under `~/.pulseed`, but mutable Kaggle workspace files should not live there.
