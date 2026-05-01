import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import HomeScreen from '../screens/HomeScreen';
import RoomScreen from '../screens/RoomScreen';
import { RootStackParamList } from '../types';

const Stack = createNativeStackNavigator<RootStackParamList>();

// ダークテーマのナビゲーションヘッダー設定
const screenOptions = {
  headerStyle: {
    backgroundColor: '#0f0a1e',
  },
  headerTintColor: '#ffffff',
  headerTitleStyle: {
    fontWeight: 'bold' as const,
    color: '#a78bfa',
  },
  headerShadowVisible: false,
  contentStyle: {
    backgroundColor: '#0f0a1e',
  },
};

export default function Navigation() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Home" screenOptions={screenOptions}>
        {/* ホーム画面（ヘッダーなし） */}
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ headerShown: false }}
        />
        {/* ルーム画面 */}
        <Stack.Screen
          name="Room"
          component={RoomScreen}
          options={{ title: '指スマオンライン' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
