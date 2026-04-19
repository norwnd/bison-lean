// This code is available on the terms of the project LICENSE.md file,
// also available online at https://blueoakcouncil.org/license/1.0.0.

// Package intl is a minimal shim left over from the Go-side translator
// worksheet pipeline (removed in CL-WORKSHEET-KILL). Only the Translation
// struct remains — `client/core/locale_ntfn.go` uses it as the field type
// for the per-topic subject/template strings it registers with
// `golang.org/x/text/message` at startup.
//
// The Version and Notes fields are no longer read anywhere; they stay on
// the struct to avoid touching the ~360 struct literals in locale_ntfn.go
// as drive-by in this cleanup. Pruning them is a follow-up.
package intl

// Translation is a versioned localized string. Version and Notes are dead
// fields retained until the locale_ntfn.go literals are updated (see
// package-level comment).
type Translation struct {
	Version int
	T       string
	Notes   string // english only
}
