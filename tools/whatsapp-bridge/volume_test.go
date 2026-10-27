package main

// Tests never depend on the machine's own free space: a store built in a test
// sees a roomy volume unless the test sets one.
func init() {
	defaultVolumeSpace = func(string) (uint64, uint64, error) {
		return 1 << 40, 1 << 40, nil
	}
}
