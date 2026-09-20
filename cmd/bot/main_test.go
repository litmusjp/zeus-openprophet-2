package main

import "testing"

func TestExecutionModeEnabledFailsClosed(t *testing.T) {
	cases := []struct {
		mode string
		want bool
	}{
		{"", false},
		{"inert", false},
		{"true", false},
		{"paper", true},
		{"PAPER ", true},
		{"ENABLED ", true},
		{"enabled", true},
	}
	for _, tc := range cases {
		if got := executionModeEnabled(tc.mode); got != tc.want {
			t.Fatalf("executionModeEnabled(%q) = %v, want %v", tc.mode, got, tc.want)
		}
	}
}

func TestInertStartupDoesNotBindOrStartRuntime(t *testing.T) {
	if shouldStartHTTPServer(false) {
		t.Fatal("inert startup must not bind an HTTP port")
	}
	if !shouldStartHTTPServer(true) {
		t.Fatal("enabled startup must retain HTTP server behavior")
	}
}
