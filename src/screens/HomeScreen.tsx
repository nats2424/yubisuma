import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { RootStackParamList } from '../types';

// カラーテーマ定数
const COLORS = {
  background: '#0f0a1e',
  surface: '#1a1333',
  primary: '#6366f1',
  accent: '#a78bfa',
  text: '#ffffff',
  textMuted: '#8b8fa8',
  border: '#2d2650',
  error: '#f87171',
};

type HomeScreenProps = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

// 4桁のランダムなルームコードを生成する
const generateRoomCode = (): string => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

// ランダムなプレイヤーIDを生成する（暫定的にUUID風の文字列）
const generatePlayerId = (): string => {
  return 'player_' + Math.random().toString(36).substring(2, 11);
};

export default function HomeScreen({ navigation }: HomeScreenProps) {
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // 入力バリデーション
  const validateName = (): boolean => {
    if (!playerName.trim()) {
      Alert.alert('エラー', 'ニックネームを入力してください');
      return false;
    }
    if (playerName.trim().length > 10) {
      Alert.alert('エラー', 'ニックネームは10文字以内にしてください');
      return false;
    }
    return true;
  };

  // ルームを新規作成する
  const handleCreateRoom = async () => {
    if (!validateName()) return;

    setIsLoading(true);
    try {
      const playerId = generatePlayerId();
      const roomCode = generateRoomCode();

      // TODO: Supabaseのroomsテーブルにルームを作成する
      // const { data, error } = await supabase
      //   .from('rooms')
      //   .insert({
      //     code: roomCode,
      //     status: 'waiting',
      //     host_id: playerId,
      //     max_players: 4,
      //     current_round: 1,
      //     players: [{ id: playerId, name: playerName.trim(), fingers: null, prediction: null, status: 'waiting', is_winner: false }],
      //   })
      //   .select()
      //   .single();

      // スキャフォールド段階では直接RoomScreenへ遷移
      navigation.navigate('Room', {
        roomCode,
        playerId,
        playerName: playerName.trim(),
      });
    } catch (error) {
      Alert.alert('エラー', 'ルームの作成に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  // 既存のルームに参加する
  const handleJoinRoom = async () => {
    if (!validateName()) return;

    if (!joinCode.trim() || joinCode.trim().length !== 4) {
      Alert.alert('エラー', '4桁のルームコードを入力してください');
      return;
    }

    setIsLoading(true);
    try {
      const playerId = generatePlayerId();
      const code = joinCode.trim();

      // TODO: Supabaseのroomsテーブルからルームを検索して参加する
      // const { data, error } = await supabase
      //   .from('rooms')
      //   .select()
      //   .eq('code', code)
      //   .eq('status', 'waiting')
      //   .single();

      // スキャフォールド段階では直接RoomScreenへ遷移
      navigation.navigate('Room', {
        roomCode: code,
        playerId,
        playerName: playerName.trim(),
      });
    } catch (error) {
      Alert.alert('エラー', 'ルームへの参加に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* ロゴ・タイトルエリア */}
        <View style={styles.logoArea}>
          <Text style={styles.logoEmoji}>✌️</Text>
          <Text style={styles.title}>指スマオンライン</Text>
          <Text style={styles.subtitle}>リアルタイム対戦ゲーム</Text>
        </View>

        {/* 入力エリア */}
        <View style={styles.inputArea}>
          {/* ニックネーム入力 */}
          <Text style={styles.label}>ニックネーム</Text>
          <TextInput
            style={styles.input}
            value={playerName}
            onChangeText={setPlayerName}
            placeholder="例: たろう（10文字以内）"
            placeholderTextColor={COLORS.textMuted}
            maxLength={10}
            autoCorrect={false}
          />

          {/* ルーム作成ボタン */}
          <TouchableOpacity
            style={[styles.button, styles.buttonPrimary]}
            onPress={handleCreateRoom}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color={COLORS.text} />
            ) : (
              <Text style={styles.buttonText}>ルームを作る</Text>
            )}
          </TouchableOpacity>

          {/* 区切り線 */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>または</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* ルーム参加コード入力 */}
          <Text style={styles.label}>ルームコード（4桁）</Text>
          <TextInput
            style={styles.input}
            value={joinCode}
            onChangeText={setJoinCode}
            placeholder="例: 4823"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="numeric"
            maxLength={4}
          />

          {/* ルーム参加ボタン */}
          <TouchableOpacity
            style={[styles.button, styles.buttonSecondary]}
            onPress={handleJoinRoom}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color={COLORS.accent} />
            ) : (
              <Text style={[styles.buttonText, styles.buttonTextSecondary]}>
                ルームに参加
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  // ロゴエリア
  logoArea: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoEmoji: {
    fontSize: 64,
    marginBottom: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: COLORS.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: COLORS.textMuted,
  },
  // 入力エリア
  inputArea: {
    gap: 12,
  },
  label: {
    fontSize: 14,
    color: COLORS.textMuted,
    marginBottom: -4,
  },
  input: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: COLORS.text,
  },
  // ボタン共通
  button: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  // プライマリボタン（ルーム作成）
  buttonPrimary: {
    backgroundColor: COLORS.primary,
  },
  // セカンダリボタン（ルーム参加）
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: COLORS.accent,
  },
  buttonTextSecondary: {
    color: COLORS.accent,
  },
  // 区切り線
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.border,
  },
  dividerText: {
    fontSize: 13,
    color: COLORS.textMuted,
  },
});
