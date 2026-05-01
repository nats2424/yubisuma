import { StatusBar } from 'expo-status-bar';
import React from 'react';
import Navigation from './src/navigation';

export default function App() {
  return (
    <>
      <Navigation />
      {/* ダークテーマに合わせてステータスバーをライト表示 */}
      <StatusBar style="light" />
    </>
  );
}
