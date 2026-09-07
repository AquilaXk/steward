# Contributing

Run `npm run check` and `npm test` for core behavior changes. Use focused tests during
development, then the required acceptance suite for a release. Document-only edits
need the relevant package/document checks, not arbitrary extra testing.

Keep source and developer documentation in readable English. Keep README.md as the
English entrypoint and README.ko.md aligned in structure and behavior. Use Node built-ins unless a dependency has a
concrete benefit that outweighs the local install and audit cost.

Add a regression test for a real failure mode. Do not remove a deny response, weaken
schema validation or skip a required check to make a test pass. Keep host protocol tests
separate from live-host observations. Update source references when relying on a changed
host contract, and leave unsupported integrations explicit.

The package version is defined in package.json and package-lock.json. `private:true`
prevents accidental npm publication; intentionally change it only during a separately
reviewed release process. The included GitHub workflow does not publish packages or
create releases.
