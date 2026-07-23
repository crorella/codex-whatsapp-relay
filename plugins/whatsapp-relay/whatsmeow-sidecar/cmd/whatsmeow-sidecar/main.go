package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	waE2E "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

const protocolVersion = 1
const defaultMaxMediaBytes uint64 = 50 * 1024 * 1024

type request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type envelope struct {
	Protocol int    `json:"protocol"`
	ID       int64  `json:"id,omitempty"`
	OK       bool   `json:"ok,omitempty"`
	Result   any    `json:"result,omitempty"`
	Error    string `json:"error,omitempty"`
	Event    string `json:"event,omitempty"`
	Data     any    `json:"data,omitempty"`
}

type status struct {
	Status         string `json:"status"`
	HasCredentials bool   `json:"hasCredentials"`
	User           string `json:"user,omitempty"`
	LastDisconnect string `json:"lastDisconnect,omitempty"`
}

type sendParams struct {
	ChatID string `json:"chatId"`
	Text   string `json:"text"`
}

type service struct {
	ctx                      context.Context
	cancel                   context.CancelFunc
	client                   *whatsmeow.Client
	sessionDB                string
	mediaDir                 string
	maxMediaBytes            uint64
	mediaSlots               chan struct{}
	encoder                  *json.Encoder
	writeMu                  sync.Mutex
	stateMu                  sync.RWMutex
	status                   status
	authAttempt              bool
	connectTried             bool
	loginReconnectUsed       bool
	loginReconnectInProgress bool
}

func main() {
	sessionDB := strings.TrimSpace(os.Getenv("WHATSAPP_SESSION_DB"))
	if sessionDB == "" {
		fmt.Fprintln(os.Stderr, "whatsmeow sidecar configuration error")
		os.Exit(2)
	}

	svc, err := newService(sessionDB, os.Stdout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whatsmeow sidecar initialization error")
		os.Exit(1)
	}
	defer svc.close()

	if err := svc.serve(os.Stdin); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintln(os.Stderr, "whatsmeow sidecar protocol error")
		os.Exit(1)
	}
}

func newService(sessionDB string, output io.Writer) (*service, error) {
	if err := hardenCredentialPath(sessionDB); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	container, err := sqlstore.New(ctx, "sqlite3", "file:"+sessionDB+"?_foreign_keys=on", waLog.Noop)
	if err != nil {
		cancel()
		return nil, err
	}
	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		cancel()
		return nil, err
	}
	client := whatsmeow.NewClient(deviceStore, waLog.Noop)
	configureClient(client)
	mediaDir := strings.TrimSpace(os.Getenv("WHATSAPP_MEDIA_DIR"))
	if mediaDir == "" {
		mediaDir = filepath.Join(filepath.Dir(filepath.Dir(sessionDB)), "media")
	}
	if err := hardenMediaPath(mediaDir); err != nil {
		cancel()
		return nil, err
	}
	maxMediaBytes := defaultMaxMediaBytes
	if configured := strings.TrimSpace(os.Getenv("WHATSAPP_MAX_MEDIA_BYTES")); configured != "" {
		parsed, parseErr := strconv.ParseUint(configured, 10, 64)
		if parseErr != nil || parsed == 0 {
			cancel()
			return nil, errors.New("invalid media size limit")
		}
		maxMediaBytes = parsed
	}

	svc := &service{
		ctx:           ctx,
		cancel:        cancel,
		client:        client,
		sessionDB:     sessionDB,
		mediaDir:      mediaDir,
		maxMediaBytes: maxMediaBytes,
		mediaSlots:    make(chan struct{}, 2),
		encoder:       json.NewEncoder(output),
		status: status{
			Status:         "idle",
			HasCredentials: deviceStore.ID != nil,
		},
	}
	client.AddEventHandler(svc.handleEvent)
	if err := svc.hardenCredentials(); err != nil {
		svc.close()
		return nil, err
	}
	return svc, nil
}

func hardenMediaPath(mediaDir string) error {
	clean := filepath.Clean(mediaDir)
	if clean == "." || clean == string(filepath.Separator) {
		return errors.New("unsafe media directory path")
	}
	if info, err := os.Lstat(clean); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("media path must be a directory, not a symlink")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(clean, 0o700); err != nil {
		return err
	}
	return os.Chmod(clean, 0o700)
}

func configureClient(client *whatsmeow.Client) {
	client.EnableAutoReconnect = false
	client.InitialAutoReconnect = false
	client.DisableLoginAutoReconnect = true
	client.EnableDecryptedEventBuffer = false
	client.UseRetryMessageStore = false
	client.ManualHistorySyncDownload = true
	client.AutomaticMessageRerequestFromPhone = false
}

func hardenCredentialPath(sessionDB string) error {
	clean := filepath.Clean(sessionDB)
	if clean == "." || clean == string(filepath.Separator) {
		return errors.New("unsafe session database path")
	}
	parent := filepath.Dir(clean)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(clean); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("session database must not be a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (s *service) hardenCredentials() error {
	if err := os.Chmod(filepath.Dir(s.sessionDB), 0o700); err != nil {
		return err
	}
	paths, err := filepath.Glob(s.sessionDB + "*")
	if err != nil {
		return err
	}
	for _, path := range paths {
		info, statErr := os.Lstat(path)
		if statErr != nil {
			return statErr
		}
		if info.Mode().IsRegular() {
			if err := os.Chmod(path, 0o600); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *service) serve(input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			s.respondError(0, "invalid_request")
			continue
		}
		if req.ID <= 0 || strings.TrimSpace(req.Method) == "" {
			s.respondError(req.ID, "invalid_request")
			continue
		}
		s.handleRequest(req)
	}
	return scanner.Err()
}

func (s *service) handleRequest(req request) {
	switch req.Method {
	case "status":
		s.respondOK(req.ID, s.snapshot())
	case "start_auth":
		if err := s.startAuth(); err != nil {
			s.respondError(req.ID, safeErrorLabel(err))
			return
		}
		s.respondOK(req.ID, s.snapshot())
	case "connect_saved":
		if err := s.connectSaved(); err != nil {
			s.respondError(req.ID, safeErrorLabel(err))
			return
		}
		s.respondOK(req.ID, s.snapshot())
	case "list_chats":
		if !s.client.IsConnected() {
			s.respondError(req.ID, "not_connected")
			return
		}
		chats, err := s.collectChats()
		if err != nil {
			s.respondError(req.ID, "chat_sync_failed")
			return
		}
		s.respondOK(req.ID, chats)
	case "send_text":
		var params sendParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			s.respondError(req.ID, "invalid_send_request")
			return
		}
		messageID, err := s.sendText(params)
		if err != nil {
			s.respondError(req.ID, safeErrorLabel(err))
			return
		}
		s.respondOK(req.ID, map[string]string{"messageId": messageID})
	case "shutdown":
		s.respondOK(req.ID, map[string]bool{"stopping": true})
		s.cancel()
	default:
		s.respondError(req.ID, "unknown_method")
	}
	_ = s.hardenCredentials()
}

func (s *service) startAuth() error {
	s.stateMu.Lock()
	if s.status.HasCredentials {
		s.stateMu.Unlock()
		return s.connectSaved()
	}
	if s.authAttempt {
		s.stateMu.Unlock()
		return errors.New("auth_attempt_already_used")
	}
	s.authAttempt = true
	s.status.Status = "connecting"
	s.status.LastDisconnect = ""
	s.stateMu.Unlock()
	s.emitStatus()

	qrChan, err := s.client.GetQRChannel(s.ctx)
	if err != nil {
		s.setDisconnected("qr_channel_failed")
		return err
	}
	if err := s.client.Connect(); err != nil {
		s.setDisconnected("connect_failed")
		return err
	}
	go s.consumeQR(qrChan)
	return nil
}

func (s *service) connectSaved() error {
	s.stateMu.Lock()
	if !s.status.HasCredentials {
		s.stateMu.Unlock()
		return errors.New("credentials_missing")
	}
	if s.client.IsConnected() {
		s.status.Status = "connected"
		s.stateMu.Unlock()
		return nil
	}
	if s.connectTried {
		s.stateMu.Unlock()
		return errors.New("connect_attempt_already_used")
	}
	s.connectTried = true
	s.status.Status = "connecting"
	s.status.LastDisconnect = ""
	s.stateMu.Unlock()
	s.emitStatus()
	if err := s.client.Connect(); err != nil {
		s.setDisconnected("connect_failed")
		return err
	}
	return nil
}

func (s *service) consumeQR(ch <-chan whatsmeow.QRChannelItem) {
	for item := range ch {
		switch item.Event {
		case whatsmeow.QRChannelEventCode:
			s.stateMu.Lock()
			s.status.Status = "awaiting_qr_scan"
			s.stateMu.Unlock()
			s.emit("qr", map[string]any{
				"payload":        item.Code,
				"timeoutSeconds": int(item.Timeout.Seconds()),
			})
			s.emitStatus()
		case "success":
			return
		case "timeout":
			s.setDisconnected("qr_timeout")
			return
		default:
			s.setDisconnected("pairing_rejected")
			return
		}
	}
}

func (s *service) sendText(params sendParams) (string, error) {
	if !s.client.IsConnected() {
		return "", errors.New("not_connected")
	}
	if strings.TrimSpace(params.ChatID) == "" || strings.TrimSpace(params.Text) == "" {
		return "", errors.New("invalid_send_request")
	}
	if len([]rune(params.Text)) > 4000 {
		return "", errors.New("message_too_long")
	}
	jid, err := types.ParseJID(params.ChatID)
	if err != nil || jid.IsEmpty() {
		return "", errors.New("invalid_chat_id")
	}
	messageID := string(s.client.GenerateMessageID())
	_, err = s.client.SendMessage(s.ctx, jid, buildTextMessage(params.Text), whatsmeow.SendRequestExtra{ID: types.MessageID(messageID)})
	if err != nil {
		return "", errors.New("send_failed")
	}
	return messageID, nil
}

func buildTextMessage(text string) *waE2E.Message {
	return &waE2E.Message{Conversation: proto.String(text)}
}

func (s *service) collectChats() ([]map[string]any, error) {
	result := make([]map[string]any, 0)
	groups, err := s.client.GetJoinedGroups(s.ctx)
	if err != nil {
		return nil, err
	}
	for _, group := range groups {
		result = append(result, map[string]any{
			"id":      group.JID.String(),
			"name":    group.Name,
			"isGroup": true,
		})
	}
	contacts, err := s.client.Store.Contacts.GetAllContacts(s.ctx)
	if err != nil {
		return nil, err
	}
	for jid, contact := range contacts {
		name := firstNonEmpty(contact.FullName, contact.FirstName, contact.PushName, contact.BusinessName)
		if name == "" {
			continue
		}
		result = append(result, map[string]any{
			"id":      jid.String(),
			"name":    name,
			"isGroup": false,
		})
	}
	return result, nil
}

func (s *service) handleEvent(raw any) {
	switch evt := raw.(type) {
	case *events.Connected:
		s.stateMu.Lock()
		s.loginReconnectInProgress = false
		s.status.Status = "connected"
		s.status.HasCredentials = s.client.Store.ID != nil
		if s.client.Store.ID != nil {
			s.status.User = s.client.Store.ID.String()
		}
		s.status.LastDisconnect = ""
		s.stateMu.Unlock()
		_ = s.hardenCredentials()
		s.emitStatus()
		go s.emitChats()
	case *events.Message:
		go s.emitMessage(evt)
	case *events.LoggedOut:
		s.stateMu.Lock()
		s.status.Status = "logged_out"
		s.status.HasCredentials = false
		s.status.User = ""
		s.status.LastDisconnect = "logged_out"
		s.stateMu.Unlock()
		s.emitStatus()
	case *events.ClientOutdated:
		s.setDisconnected("client_outdated")
	case *events.ConnectFailure:
		s.setDisconnected("connect_failure_" + evt.Reason.NumberString())
	case *events.TemporaryBan:
		s.setDisconnected("temporary_ban")
	case *events.StreamReplaced:
		s.setDisconnected("connection_replaced")
	case *events.ManualLoginReconnect:
		s.startRequiredLoginReconnect()
	case *events.Disconnected:
		s.stateMu.RLock()
		loginReconnectInProgress := s.loginReconnectInProgress
		s.stateMu.RUnlock()
		if !loginReconnectInProgress {
			s.setDisconnected("connection_lost")
		}
	case *events.PairError:
		s.setDisconnected("pairing_failed")
	}
}

func (s *service) startRequiredLoginReconnect() {
	s.stateMu.Lock()
	if s.loginReconnectUsed {
		s.stateMu.Unlock()
		s.setDisconnected("login_reconnect_already_used")
		return
	}
	s.loginReconnectUsed = true
	s.loginReconnectInProgress = true
	s.status.Status = "connecting"
	s.status.HasCredentials = s.client.Store.ID != nil
	s.stateMu.Unlock()
	s.emitStatus()
	go func() {
		s.client.Disconnect()
		if err := s.client.Connect(); err != nil {
			s.stateMu.Lock()
			s.loginReconnectInProgress = false
			s.stateMu.Unlock()
			s.setDisconnected("login_reconnect_failed")
		}
	}()
}

func (s *service) emitChats() {
	chats, err := s.collectChats()
	if err != nil {
		return
	}
	for _, chat := range chats {
		s.emit("chat", chat)
	}
}

func (s *service) emitMessage(evt *events.Message) {
	if evt == nil || evt.Message == nil {
		return
	}
	text, messageType := extractText(evt.Message)
	media := describeMedia(evt.Message)
	structured := extractStructured(evt.Message)
	chatID := evt.Info.Chat.String()
	senderID := evt.Info.Sender.String()
	s.emit("chat", map[string]any{
		"id":        chatID,
		"name":      evt.Info.PushName,
		"isGroup":   evt.Info.IsGroup,
		"timestamp": evt.Info.Timestamp.Unix(),
	})
	payload := map[string]any{
		"id":          string(evt.Info.ID),
		"chatId":      chatID,
		"senderId":    senderID,
		"fromMe":      evt.Info.IsFromMe,
		"pushName":    evt.Info.PushName,
		"timestamp":   evt.Info.Timestamp.Unix(),
		"text":        truncateRunes(text, 16000),
		"messageType": messageType,
	}
	if media != nil {
		payload["attachments"] = []map[string]any{s.cacheMedia(string(evt.Info.ID), media)}
	}
	if structured != nil {
		payload["structured"] = structured
	}
	s.emit("message", payload)
}

type mediaDescription struct {
	Kind         string
	MIMEType     string
	OriginalName string
	DeclaredSize uint64
	Duration     uint32
	PTT          bool
	Downloadable whatsmeow.DownloadableMessage
}

func unwrapMessage(message *waE2E.Message) *waE2E.Message {
	if message == nil {
		return nil
	}
	if inner := message.GetEphemeralMessage().GetMessage(); inner != nil {
		return unwrapMessage(inner)
	}
	if inner := message.GetViewOnceMessage().GetMessage(); inner != nil {
		return unwrapMessage(inner)
	}
	if inner := message.GetViewOnceMessageV2().GetMessage(); inner != nil {
		return unwrapMessage(inner)
	}
	if inner := message.GetDocumentWithCaptionMessage().GetMessage(); inner != nil {
		return unwrapMessage(inner)
	}
	return message
}

func describeMedia(message *waE2E.Message) *mediaDescription {
	message = unwrapMessage(message)
	if message == nil {
		return nil
	}
	if item := message.GetAudioMessage(); item != nil {
		return &mediaDescription{Kind: "audio", MIMEType: item.GetMimetype(), DeclaredSize: item.GetFileLength(), Duration: item.GetSeconds(), PTT: item.GetPTT(), Downloadable: item}
	}
	if item := message.GetImageMessage(); item != nil {
		return &mediaDescription{Kind: "image", MIMEType: item.GetMimetype(), DeclaredSize: item.GetFileLength(), Downloadable: item}
	}
	if item := message.GetVideoMessage(); item != nil {
		return &mediaDescription{Kind: "video", MIMEType: item.GetMimetype(), DeclaredSize: item.GetFileLength(), Duration: item.GetSeconds(), Downloadable: item}
	}
	if item := message.GetDocumentMessage(); item != nil {
		return &mediaDescription{Kind: "document", MIMEType: item.GetMimetype(), OriginalName: item.GetFileName(), DeclaredSize: item.GetFileLength(), Downloadable: item}
	}
	if item := message.GetStickerMessage(); item != nil {
		return &mediaDescription{Kind: "sticker", MIMEType: item.GetMimetype(), DeclaredSize: item.GetFileLength(), Downloadable: item}
	}
	return nil
}

func extractStructured(message *waE2E.Message) map[string]any {
	message = unwrapMessage(message)
	if message == nil {
		return nil
	}
	if item := message.GetLocationMessage(); item != nil {
		return map[string]any{"kind": "location", "latitude": item.GetDegreesLatitude(), "longitude": item.GetDegreesLongitude(), "name": item.GetName(), "address": item.GetAddress()}
	}
	if item := message.GetLiveLocationMessage(); item != nil {
		return map[string]any{"kind": "live_location", "latitude": item.GetDegreesLatitude(), "longitude": item.GetDegreesLongitude(), "caption": item.GetCaption()}
	}
	if item := message.GetContactMessage(); item != nil {
		return map[string]any{"kind": "contact", "displayName": item.GetDisplayName(), "vcard": item.GetVcard()}
	}
	if item := message.GetContactsArrayMessage(); item != nil {
		return map[string]any{"kind": "contacts", "displayName": item.GetDisplayName(), "count": len(item.GetContacts())}
	}
	poll := firstPoll(message)
	if poll != nil {
		options := make([]string, 0, len(poll.GetOptions()))
		for _, option := range poll.GetOptions() {
			options = append(options, option.GetOptionName())
		}
		return map[string]any{"kind": "poll", "name": poll.GetName(), "options": options}
	}
	return nil
}

func firstPoll(message *waE2E.Message) *waE2E.PollCreationMessage {
	for _, poll := range []*waE2E.PollCreationMessage{message.GetPollCreationMessage(), message.GetPollCreationMessageV2(), message.GetPollCreationMessageV3(), message.GetPollCreationMessageV5(), message.GetPollCreationMessageV6()} {
		if poll != nil {
			return poll
		}
	}
	return nil
}

func (s *service) cacheMedia(messageID string, media *mediaDescription) map[string]any {
	result := map[string]any{
		"kind": media.Kind, "mimeType": media.MIMEType, "originalFileName": media.OriginalName,
		"declaredSize": media.DeclaredSize, "durationSeconds": media.Duration, "ptt": media.PTT,
	}
	if media.DeclaredSize > s.maxMediaBytes {
		result["status"] = "too_large"
		result["maxBytes"] = s.maxMediaBytes
		return result
	}
	s.mediaSlots <- struct{}{}
	defer func() { <-s.mediaSlots }()
	data, err := s.client.Download(s.ctx, media.Downloadable)
	if err != nil {
		result["status"] = "download_failed"
		return result
	}
	if uint64(len(data)) > s.maxMediaBytes {
		result["status"] = "too_large"
		result["size"] = len(data)
		result["maxBytes"] = s.maxMediaBytes
		return result
	}
	fileName := mediaFileName(messageID, media)
	filePath := filepath.Join(s.mediaDir, fileName)
	if err := writePrivateMedia(filePath, data); err != nil {
		result["status"] = "write_failed"
		return result
	}
	result["status"] = "downloaded"
	result["size"] = len(data)
	result["fileName"] = fileName
	result["path"] = filePath
	return result
}

func mediaFileName(messageID string, media *mediaDescription) string {
	base := sanitizeFilePart(messageID)
	if base == "" {
		base = "message"
	}
	if media.OriginalName != "" {
		original := sanitizeFilePart(filepath.Base(media.OriginalName))
		if original != "" {
			return base + "-" + original
		}
	}
	extension := mediaExtension(media.MIMEType)
	return base + extension
}

func sanitizeFilePart(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '.' || char == '-' || char == '_' {
			builder.WriteRune(char)
		} else {
			builder.WriteByte('_')
		}
		if builder.Len() >= 120 {
			break
		}
	}
	return strings.Trim(builder.String(), "._-")
}

func mediaExtension(mimeType string) string {
	clean := strings.TrimSpace(strings.Split(mimeType, ";")[0])
	if extensions, err := mime.ExtensionsByType(clean); err == nil && len(extensions) > 0 {
		return extensions[0]
	}
	return map[string]string{"audio/ogg": ".ogg", "audio/opus": ".opus", "image/webp": ".webp"}[clean]
}

func writePrivateMedia(filePath string, data []byte) error {
	file, err := os.OpenFile(filePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Chmod(filePath, 0o600)
}

func extractText(message *waE2E.Message) (string, string) {
	message = unwrapMessage(message)
	if message == nil {
		return "", "unknown"
	}
	if text := message.GetConversation(); text != "" {
		return text, "conversation"
	}
	if extended := message.GetExtendedTextMessage(); extended != nil {
		return extended.GetText(), "extendedTextMessage"
	}
	if image := message.GetImageMessage(); image != nil {
		return image.GetCaption(), "imageMessage"
	}
	if video := message.GetVideoMessage(); video != nil {
		return video.GetCaption(), "videoMessage"
	}
	if document := message.GetDocumentMessage(); document != nil {
		return document.GetCaption(), "documentMessage"
	}
	if message.GetAudioMessage() != nil {
		return "", "audioMessage"
	}
	if message.GetStickerMessage() != nil {
		return "", "stickerMessage"
	}
	if location := message.GetLocationMessage(); location != nil {
		return firstNonEmpty(location.GetName(), location.GetAddress()), "locationMessage"
	}
	if location := message.GetLiveLocationMessage(); location != nil {
		return location.GetCaption(), "liveLocationMessage"
	}
	if contact := message.GetContactMessage(); contact != nil {
		return contact.GetDisplayName(), "contactMessage"
	}
	if contacts := message.GetContactsArrayMessage(); contacts != nil {
		return contacts.GetDisplayName(), "contactsArrayMessage"
	}
	if poll := firstPoll(message); poll != nil {
		return poll.GetName(), "pollCreationMessage"
	}
	return "", "unknown"
}

func (s *service) setDisconnected(label string) {
	s.stateMu.Lock()
	if s.status.Status != "logged_out" && !(s.status.Status == "disconnected" && s.status.LastDisconnect != "") {
		s.status.Status = "disconnected"
		s.status.LastDisconnect = label
	}
	s.stateMu.Unlock()
	s.emitStatus()
}

func (s *service) snapshot() status {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	return s.status
}

func (s *service) emitStatus() {
	s.emit("status", s.snapshot())
}

func (s *service) emit(event string, data any) {
	s.write(envelope{Protocol: protocolVersion, Event: event, Data: data})
}

func (s *service) respondOK(id int64, result any) {
	s.write(envelope{Protocol: protocolVersion, ID: id, OK: true, Result: result})
}

func (s *service) respondError(id int64, label string) {
	s.write(envelope{Protocol: protocolVersion, ID: id, Error: label})
}

func (s *service) write(value envelope) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.encoder.Encode(value)
}

func (s *service) close() {
	if s.client != nil {
		s.client.Disconnect()
	}
	if s.cancel != nil {
		s.cancel()
	}
	_ = s.hardenCredentials()
}

func safeErrorLabel(err error) string {
	if err == nil {
		return "unknown_error"
	}
	label := err.Error()
	switch label {
	case "auth_attempt_already_used", "connect_attempt_already_used", "credentials_missing", "not_connected", "invalid_send_request", "message_too_long", "invalid_chat_id", "send_failed":
		return label
	default:
		return "transport_error"
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}
