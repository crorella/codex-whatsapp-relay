package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func TestConfigureClientDisablesAllAutomaticReconnect(t *testing.T) {
	client := &whatsmeow.Client{
		EnableAutoReconnect:  true,
		InitialAutoReconnect: true,
	}
	configureClient(client)
	if client.EnableAutoReconnect || client.InitialAutoReconnect || !client.DisableLoginAutoReconnect {
		t.Fatalf("automatic reconnect was not fully disabled: %#v", client)
	}
	if client.EnableDecryptedEventBuffer || client.UseRetryMessageStore || !client.ManualHistorySyncDownload || client.AutomaticMessageRerequestFromPhone {
		t.Fatalf("persistent/plaintext buffering was not fully disabled: %#v", client)
	}
}

func TestHardenCredentialPath(t *testing.T) {
	root := t.TempDir()
	authDir := filepath.Join(root, "auth")
	dbPath := filepath.Join(authDir, "whatsmeow.db")
	if err := hardenCredentialPath(dbPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbPath, []byte("secret"), 0o666); err != nil {
		t.Fatal(err)
	}
	svc := &service{sessionDB: dbPath}
	if err := svc.hardenCredentials(); err != nil {
		t.Fatal(err)
	}
	dirInfo, _ := os.Stat(authDir)
	fileInfo, _ := os.Stat(dbPath)
	if got := dirInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("auth directory mode = %o, want 700", got)
	}
	if got := fileInfo.Mode().Perm(); got != 0o600 {
		t.Fatalf("credential file mode = %o, want 600", got)
	}
}

func TestHardenCredentialPathRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.db")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := hardenCredentialPath(link); err == nil {
		t.Fatal("expected symlink rejection")
	}
}

func TestExtractTextHandlesPlainAndWrappedMessages(t *testing.T) {
	plain := &waE2E.Message{Conversation: proto.String("hello")}
	if text, kind := extractText(plain); text != "hello" || kind != "conversation" {
		t.Fatalf("plain extraction = %q %q", text, kind)
	}
	wrapper := &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: plain}}
	if text, kind := extractText(wrapper); text != "hello" || kind != "conversation" {
		t.Fatalf("wrapped extraction = %q %q", text, kind)
	}
}

func TestDescribeMediaHandlesAudioAndDocuments(t *testing.T) {
	audio := &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
		Mimetype: proto.String("audio/ogg; codecs=opus"),
		FileLength: proto.Uint64(42),
		Seconds: proto.Uint32(7),
		PTT: proto.Bool(true),
	}}
	description := describeMedia(audio)
	if description == nil || description.Kind != "audio" || description.DeclaredSize != 42 || description.Duration != 7 || !description.PTT {
		t.Fatalf("unexpected audio description: %#v", description)
	}

	document := &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
		Mimetype: proto.String("application/pdf"),
		FileName: proto.String("../../Quarterly report.pdf"),
	}}
	description = describeMedia(document)
	if description == nil || description.Kind != "document" || description.OriginalName != "../../Quarterly report.pdf" {
		t.Fatalf("unexpected document description: %#v", description)
	}
	name := mediaFileName("A/B", description)
	if strings.Contains(name, "/") || strings.Contains(name, "..") || !strings.HasSuffix(name, "Quarterly_report.pdf") {
		t.Fatalf("unsafe media filename: %q", name)
	}
}

func TestWritePrivateMediaAndMediaDirectoryPermissions(t *testing.T) {
	mediaDir := filepath.Join(t.TempDir(), "media")
	if err := hardenMediaPath(mediaDir); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(mediaDir, "audio.ogg")
	if err := writePrivateMedia(filePath, []byte("audio")); err != nil {
		t.Fatal(err)
	}
	dirInfo, _ := os.Stat(mediaDir)
	fileInfo, _ := os.Stat(filePath)
	if dirInfo.Mode().Perm() != 0o700 || fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected media modes: dir=%o file=%o", dirInfo.Mode().Perm(), fileInfo.Mode().Perm())
	}
}

func TestBuildTextMessageContainsNoPreviewMetadata(t *testing.T) {
	message := buildTextMessage("See https://example.com")
	if message.GetConversation() != "See https://example.com" {
		t.Fatalf("unexpected conversation: %q", message.GetConversation())
	}
	if message.GetExtendedTextMessage() != nil {
		t.Fatal("plain text send unexpectedly constructed extended/link-preview metadata")
	}
}

func TestServeRejectsMalformedAndUnknownRequestsWithoutEchoingInput(t *testing.T) {
	var output bytes.Buffer
	svc := &service{encoder: newJSONEncoder(&output)}
	input := strings.NewReader("not-json SECRET\n{\"id\":1,\"method\":\"not_allowed\",\"params\":{\"text\":\"SECRET\"}}\n")
	if err := svc.serve(input); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "SECRET") {
		t.Fatalf("protocol output echoed untrusted input: %s", output.String())
	}
	if !strings.Contains(output.String(), "invalid_request") || !strings.Contains(output.String(), "unknown_method") {
		t.Fatalf("unexpected protocol output: %s", output.String())
	}
}

func newJSONEncoder(output *bytes.Buffer) *json.Encoder {
	return json.NewEncoder(output)
}
