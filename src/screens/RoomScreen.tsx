import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { Player, Room, RoomStatus, RootStackParamList } from '../types';

// カラーテーマ定数
const COLORS = {
  background: '#0f0a1e',
  surface: '#1a1333',
  surfaceAlt: '#231b45',
  primary: '#6366f1',
  accent: '#a78bfa',
  text: '#ffffff',
  textMuted: '#8b8fa8',
  border: '#2d2650',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
};

type RoomScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Room'>;
  route: RouteProp<RootStackParamList, 'Room'>;
};

// モックデータ（スキャフォールド用）
const createMockRoom = (
  roomCode: string,
  playerId: string,
  playerName: string
): Room => ({
  id: 'mock_room_id',
  code: roomCode,
  status: 'waiting',
  host_id: playerId,
  max_players: 4,
  current_round: 1,
  players: [
    {
      id: playerId,
      name: playerName,
      fingers: null,
      prediction: null,
      status: 'waiting',
      is_winner: false,
    },
  ],
});

// プレイヤーステータスのバッジ表示用設定
const STATUS_BADGE: Record<
  Player['status'],
  { label: string; color: string }
> = {
  waiting: { label: '待機中', color: COLORS.textMuted },
  committed: { label: '宣言済み', color: COLORS.warning },
  revealed: { label: '公開済み', color: COLORS.success },
};

export default function RoomScreen({ navigation, route }: RoomScreenProps) {
  const { roomCode, playerId, playerName } = route.params;

  // ルーム状態
  const [room, setRoom] = useState<Room>(
    createMockRoom(roomCode, playerId, playerName)
  );
  // 自分の入力値
  const [selectedFingers, setSelectedFingers] = useState<number>(0);
  const [prediction, setPrediction] = useState<string>('');
  // 自分が宣言済みかどうか
  const [hasCommitted, setHasCommitted] = useState(false);

  // Supabase Realtimeチャンネルの参照
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Supabase Realtimeでルームの変更を購読する
  const subscribeToRoom = useCallback(() => {
    // 既存のチャンネルがあれば解除
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
    }

    // roomsテーブルの変更をリアルタイム購読
    // TODO: roomsテーブルをSupabaseで作成後に有効化
    const channel = supabase
      .channel(`room:${roomCode}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rooms',
          filter: `code=eq.${roomCode}`,
        },
        (payload) => {
          // ルームデータが更新されたら状態を同期
          if (payload.new) {
            setRoom(payload.new as Room);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log(`ルーム ${roomCode} の購読を開始しました`);
        }
      });

    channelRef.current = channel;
  }, [roomCode]);

  useEffect(() => {
    subscribeToRoom();

    // コンポーネントのアンマウント時に購読を解除
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, [subscribeToRoom]);

  // ゲーム開始（ホストのみ実行可能）
  const handleStartGame = async () => {
    if (room.players.length < 2) {
      Alert.alert('エラー', 'ゲームを開始するには2人以上必要です');
      return;
    }

    // TODO: Supabase Edge Function または DB Function を呼び出してゲームを開始する
    // const { error } = await supabase.functions.invoke('start-game', { body: { roomCode } });

    // スキャフォールド用のモック処理
    setRoom((prev) => ({ ...prev, status: 'playing' }));
  };

  // 指の本数と予想を宣言する（コミット＆リビール方式）
  const handleCommit = async () => {
    const predictionNum = parseInt(prediction, 10);
    const maxPossible = room.players.length * 5;

    if (isNaN(predictionNum) || predictionNum < 0 || predictionNum > maxPossible) {
      Alert.alert(
        'エラー',
        `合計予想は0〜${maxPossible}の整数を入力してください`
      );
      return;
    }

    // TODO: サーバー側でコミットを記録する（実際の値はハッシュ化して保存）
    // const { error } = await supabase.functions.invoke('commit-move', {
    //   body: { roomCode, playerId, fingers: selectedFingers, prediction: predictionNum },
    // });

    // スキャフォールド用のモック処理
    setHasCommitted(true);
    setRoom((prev) => ({
      ...prev,
      players: prev.players.map((p) =>
        p.id === playerId ? { ...p, status: 'committed' } : p
      ),
    }));
  };

  // 結果を公開する
  const handleReveal = async () => {
    // TODO: サーバー側で全員のコミット内容を公開し、勝者を判定する
    // const { error } = await supabase.functions.invoke('reveal-moves', { body: { roomCode } });

    // スキャフォールド用のモック処理
    setRoom((prev) => ({
      ...prev,
      status: 'finished',
      players: prev.players.map((p) =>
        p.id === playerId
          ? {
              ...p,
              fingers: selectedFingers,
              prediction: parseInt(prediction, 10),
              status: 'revealed',
              is_winner: false,
            }
          : p
      ),
    }));
  };

  // もう一度プレイする
  const handlePlayAgain = async () => {
    // TODO: Supabase Edge Function を呼び出して次のラウンドを開始する

    // スキャフォールド用のモック処理
    setHasCommitted(false);
    setSelectedFingers(0);
    setPrediction('');
    setRoom((prev) => ({
      ...prev,
      status: 'playing',
      current_round: prev.current_round + 1,
      players: prev.players.map((p) => ({
        ...p,
        fingers: null,
        prediction: null,
        status: 'waiting',
        is_winner: false,
      })),
    }));
  };

  // 全員が宣言済みかどうかチェック
  const allCommitted = room.players.every((p) => p.status !== 'waiting');
  // 自分がホストかどうか
  const isHost = room.host_id === playerId;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        {/* ヘッダー：ルームコード + ラウンド表示 */}
        <View style={styles.header}>
          <View>
            <Text style={styles.roomCodeLabel}>ルームコード</Text>
            <Text style={styles.roomCode}>{room.code}</Text>
          </View>
          <View style={styles.roundBadge}>
            <Text style={styles.roundText}>ラウンド {room.current_round}</Text>
          </View>
        </View>

        {/* プレイヤー一覧 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            参加者 ({room.players.length}/{room.max_players})
          </Text>
          {room.players.map((player) => (
            <PlayerCard
              key={player.id}
              player={player}
              isMe={player.id === playerId}
              roomStatus={room.status}
            />
          ))}
        </View>

        {/* ゲームステータスに応じたコンテンツエリア */}
        {room.status === 'waiting' && (
          <WaitingPhase
            isHost={isHost}
            playerCount={room.players.length}
            onStartGame={handleStartGame}
          />
        )}

        {room.status === 'playing' && !hasCommitted && (
          <PlayingPhase
            players={room.players}
            selectedFingers={selectedFingers}
            onSelectFingers={setSelectedFingers}
            prediction={prediction}
            onChangePrediction={setPrediction}
            onCommit={handleCommit}
            maxPrediction={room.players.length * 5}
          />
        )}

        {room.status === 'playing' && hasCommitted && (
          <CommittedPhase
            allCommitted={allCommitted}
            isHost={isHost}
            onReveal={handleReveal}
          />
        )}

        {room.status === 'finished' && (
          <FinishedPhase players={room.players} onPlayAgain={handlePlayAgain} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// プレイヤーカードコンポーネント
function PlayerCard({
  player,
  isMe,
  roomStatus,
}: {
  player: Player;
  isMe: boolean;
  roomStatus: RoomStatus;
}) {
  const badge = STATUS_BADGE[player.status];

  return (
    <View style={[styles.playerCard, isMe && styles.playerCardMe]}>
      <View style={styles.playerInfo}>
        <Text style={styles.playerName}>
          {player.name}
          {isMe && <Text style={styles.meLabel}> (あなた)</Text>}
        </Text>
        <View style={[styles.statusBadge, { borderColor: badge.color }]}>
          <Text style={[styles.statusBadgeText, { color: badge.color }]}>
            {badge.label}
          </Text>
        </View>
      </View>

      {/* 結果フェーズでは各プレイヤーの宣言内容を表示 */}
      {roomStatus === 'finished' && player.status === 'revealed' && (
        <View style={styles.playerResult}>
          <Text style={styles.resultItem}>
            指: <Text style={styles.resultValue}>{player.fingers}本</Text>
          </Text>
          <Text style={styles.resultItem}>
            予想: <Text style={styles.resultValue}>{player.prediction}</Text>
          </Text>
          {player.is_winner && (
            <Text style={styles.winnerBadge}>🏆 勝ち</Text>
          )}
        </View>
      )}
    </View>
  );
}

// 待機フェーズ（ホストのみゲーム開始ボタン表示）
function WaitingPhase({
  isHost,
  playerCount,
  onStartGame,
}: {
  isHost: boolean;
  playerCount: number;
  onStartGame: () => void;
}) {
  return (
    <View style={styles.phaseContainer}>
      <Text style={styles.phaseTitle}>参加者を待っています...</Text>
      <Text style={styles.phaseDescription}>
        ルームコードを他のプレイヤーに共有してください。{'\n'}
        2〜4人集まったらゲームを開始できます。
      </Text>
      {isHost && playerCount >= 2 && (
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary]}
          onPress={onStartGame}
        >
          <Text style={styles.buttonText}>ゲーム開始</Text>
        </TouchableOpacity>
      )}
      {isHost && playerCount < 2 && (
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            あと{2 - playerCount}人以上参加すると開始できます
          </Text>
        </View>
      )}
    </View>
  );
}

// プレイングフェーズ（指の本数と予想を入力）
function PlayingPhase({
  players,
  selectedFingers,
  onSelectFingers,
  prediction,
  onChangePrediction,
  onCommit,
  maxPrediction,
}: {
  players: Player[];
  selectedFingers: number;
  onSelectFingers: (n: number) => void;
  prediction: string;
  onChangePrediction: (v: string) => void;
  onCommit: () => void;
  maxPrediction: number;
}) {
  return (
    <View style={styles.phaseContainer}>
      <Text style={styles.phaseTitle}>宣言してください</Text>

      {/* 指の本数選択（0〜5のボタン） */}
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>出す本数（0〜5本）</Text>
        <View style={styles.fingersRow}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <TouchableOpacity
              key={n}
              style={[
                styles.fingerButton,
                selectedFingers === n && styles.fingerButtonSelected,
              ]}
              onPress={() => onSelectFingers(n)}
            >
              <Text
                style={[
                  styles.fingerButtonText,
                  selectedFingers === n && styles.fingerButtonTextSelected,
                ]}
              >
                {n}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* 合計予想入力 */}
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>
          合計予想（0〜{maxPrediction}）
        </Text>
        <TextInput
          style={styles.input}
          value={prediction}
          onChangeText={onChangePrediction}
          placeholder={`0〜${maxPrediction}の数字`}
          placeholderTextColor={COLORS.textMuted}
          keyboardType="numeric"
          maxLength={2}
        />
      </View>

      {/* 宣言ボタン */}
      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={onCommit}
      >
        <Text style={styles.buttonText}>宣言する</Text>
      </TouchableOpacity>
    </View>
  );
}

// 宣言済みフェーズ（他のプレイヤーを待つ）
function CommittedPhase({
  allCommitted,
  isHost,
  onReveal,
}: {
  allCommitted: boolean;
  isHost: boolean;
  onReveal: () => void;
}) {
  return (
    <View style={styles.phaseContainer}>
      <Text style={styles.phaseTitle}>宣言済み ✓</Text>
      <Text style={styles.phaseDescription}>
        {allCommitted
          ? '全員が宣言しました！結果を公開しましょう。'
          : '他のプレイヤーの宣言を待っています...'}
      </Text>
      {/* ホストかつ全員が宣言済みの場合、公開ボタンを表示 */}
      {isHost && allCommitted && (
        <TouchableOpacity
          style={[styles.button, styles.buttonAccent]}
          onPress={onReveal}
        >
          <Text style={styles.buttonText}>結果を公開する</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// 結果フェーズ
function FinishedPhase({
  players,
  onPlayAgain,
}: {
  players: Player[];
  onPlayAgain: () => void;
}) {
  const winners = players.filter((p) => p.is_winner);
  const totalFingers = players.reduce((sum, p) => sum + (p.fingers ?? 0), 0);

  return (
    <View style={styles.phaseContainer}>
      <Text style={styles.phaseTitle}>結果発表</Text>
      <View style={styles.resultSummary}>
        <Text style={styles.resultSummaryText}>
          合計本数: <Text style={styles.resultValue}>{totalFingers}本</Text>
        </Text>
        {winners.length > 0 ? (
          <Text style={styles.resultSummaryText}>
            勝者:{' '}
            <Text style={styles.resultValue}>
              {winners.map((w) => w.name).join('、')}
            </Text>
          </Text>
        ) : (
          <Text style={styles.resultSummaryText}>
            正解者なし（引き分け）
          </Text>
        )}
      </View>
      <TouchableOpacity
        style={[styles.button, styles.buttonPrimary]}
        onPress={onPlayAgain}
      >
        <Text style={styles.buttonText}>もう一度</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    padding: 20,
    gap: 20,
  },
  // ヘッダー
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  roomCodeLabel: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  roomCode: {
    fontSize: 36,
    fontWeight: 'bold',
    color: COLORS.accent,
    letterSpacing: 8,
  },
  roundBadge: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roundText: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
  // セクション
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginBottom: 4,
  },
  // プレイヤーカード
  playerCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 8,
  },
  playerCardMe: {
    borderColor: COLORS.primary,
  },
  playerInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  playerName: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  meLabel: {
    fontSize: 13,
    fontWeight: 'normal',
    color: COLORS.textMuted,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  // プレイヤー結果
  playerResult: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  resultItem: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  resultValue: {
    color: COLORS.text,
    fontWeight: '600',
  },
  winnerBadge: {
    fontSize: 14,
    color: COLORS.warning,
    fontWeight: '600',
    marginLeft: 'auto',
  },
  // フェーズコンテナ（各ゲームフェーズの共通レイアウト）
  phaseContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    gap: 16,
  },
  phaseTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  phaseDescription: {
    fontSize: 14,
    color: COLORS.textMuted,
    lineHeight: 22,
  },
  // 入力グループ
  inputGroup: {
    gap: 8,
  },
  inputLabel: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  input: {
    backgroundColor: COLORS.surfaceAlt,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: COLORS.text,
  },
  // 指の本数選択ボタン
  fingersRow: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  fingerButton: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.surfaceAlt,
  },
  fingerButtonSelected: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primary + '33', // 20% opacity
  },
  fingerButtonText: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.textMuted,
  },
  fingerButtonTextSelected: {
    color: COLORS.accent,
  },
  // ボタン
  button: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: COLORS.primary,
  },
  buttonAccent: {
    backgroundColor: COLORS.accent,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  // 情報ボックス
  infoBox: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 10,
    padding: 14,
  },
  infoText: {
    fontSize: 14,
    color: COLORS.textMuted,
    textAlign: 'center',
  },
  // 結果サマリー
  resultSummary: {
    backgroundColor: COLORS.surfaceAlt,
    borderRadius: 10,
    padding: 14,
    gap: 6,
  },
  resultSummaryText: {
    fontSize: 16,
    color: COLORS.textMuted,
  },
});
