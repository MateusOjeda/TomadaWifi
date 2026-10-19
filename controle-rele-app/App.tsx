import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Pressable,
	SafeAreaView,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";

import {
	onAuthStateChanged,
	signInWithEmailAndPassword,
	signOut,
	type User,
} from "firebase/auth";

import { onValue, push, ref, set } from "firebase/database";

import { auth, database } from "./firebase/config";

type RelayState = {
	enabled: boolean;
	expiresAt: number;
	lastCommandId: string;
	lastSeenAt?: number;
};

const HEARTBEAT_TIMEOUT_MS = 90000;
const DURATIONS = [0, 10, 20, 30, 40, 50, 60];

function formatTime(seconds: number) {
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;

	return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(
		2,
		"0",
	)}`;
}

export default function App() {
	const [user, setUser] = useState<User | null>(null);
	const [authLoading, setAuthLoading] = useState(true);

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");

	const [relay, setRelay] = useState<RelayState | null>(null);

	const [connected, setConnected] = useState(false);
	const [serverOffset, setServerOffset] = useState(0);
	const [offsetReady, setOffsetReady] = useState(false);

	const [now, setNow] = useState(Date.now());
	const [duration, setDuration] = useState("30");

	const [busy, setBusy] = useState(false);
	const [pendingId, setPendingId] = useState<string | null>(null);

	const [error, setError] = useState("");

	// Autenticação
	useEffect(() => {
		return onAuthStateChanged(auth, (currentUser) => {
			setUser(currentUser);
			setAuthLoading(false);
		});
	}, []);

	// Relógio da interface
	useEffect(() => {
		const interval = setInterval(() => {
			setNow(Date.now());
		}, 1000);

		return () => clearInterval(interval);
	}, []);

	// Firebase em tempo real
	useEffect(() => {
		if (!user) {
			setRelay(null);
			setConnected(false);
			setOffsetReady(false);
			return;
		}

		const unsubscribeState = onValue(
			ref(database, "relay/state"),
			(snapshot) => {
				setRelay(snapshot.val() as RelayState | null);
			},
			(err) => setError(err.message),
		);

		const unsubscribeConnection = onValue(
			ref(database, ".info/connected"),
			(snapshot) => {
				setConnected(snapshot.val() === true);
			},
		);

		const unsubscribeOffset = onValue(
			ref(database, ".info/serverTimeOffset"),
			(snapshot) => {
				const offset = snapshot.val();

				if (typeof offset === "number") {
					setServerOffset(offset);
					setOffsetReady(true);
				}
			},
		);

		return () => {
			unsubscribeState();
			unsubscribeConnection();
			unsubscribeOffset();
		};
	}, [user]);

	// Confirmação de recebimento do comando
	useEffect(() => {
		if (pendingId && relay?.lastCommandId === pendingId) {
			setPendingId(null);
		}
	}, [pendingId, relay?.lastCommandId]);

	useEffect(() => {
		if (!pendingId) return;

		const timeout = setTimeout(() => {
			setPendingId(null);
			setError("O dispositivo não confirmou o recebimento do comando.");
		}, 20000);

		return () => clearTimeout(timeout);
	}, [pendingId]);

	const serverNow = now + serverOffset;

	const lastSeen = relay?.lastSeenAt;
	const heartbeatAge =
		typeof lastSeen === "number" ? serverNow - lastSeen : Infinity;

	const online =
		connected &&
		offsetReady &&
		heartbeatAge >= -10000 &&
		heartbeatAge < HEARTBEAT_TIMEOUT_MS;

	const remainingSeconds = Math.max(
		0,
		Math.ceil(((relay?.expiresAt ?? 0) - serverNow) / 1000),
	);

	const hasTimer = relay?.enabled === true && (relay.expiresAt ?? 0) > 0;

	const canSend = online && !busy && !pendingId;

	async function login() {
		setError("");
		setBusy(true);

		try {
			await signInWithEmailAndPassword(auth, email.trim(), password);
		} catch (err) {
			setError("Não foi possível entrar. Confira os dados.");
		} finally {
			setBusy(false);
		}
	}

	async function sendCommand(enabled: boolean) {
		if (!canSend) return;

		const minutes = enabled ? Number(duration.trim()) : 0;

		if (
			enabled &&
			(!/^\d+$/.test(duration.trim()) || minutes < 0 || minutes > 1440)
		) {
			setError("Informe um tempo entre 0 e 1440 minutos.");
			return;
		}

		const id = push(ref(database, "relay/command")).key;

		if (!id) {
			setError("Não foi possível gerar o ID do comando.");
			return;
		}

		setBusy(true);
		setError("");
		setPendingId(id);

		try {
			await set(ref(database, "relay/command"), {
				id,
				enabled,
				durationMinutes: minutes,
				createdAt: Math.round(Date.now() + serverOffset),
			});
		} catch (err) {
			setPendingId(null);
			setError("Falha ao enviar comando ao Firebase.");
		} finally {
			setBusy(false);
		}
	}

	if (authLoading) {
		return (
			<View style={styles.center}>
				<ActivityIndicator size="large" />
			</View>
		);
	}

	if (!user) {
		return (
			<SafeAreaView style={styles.screen}>
				<View style={styles.login}>
					<Text style={styles.title}>Controle do relé</Text>
					<Text style={styles.subtitle}>
						Entre com sua conta do Firebase
					</Text>

					<TextInput
						style={styles.input}
						placeholder="E-mail"
						autoCapitalize="none"
						keyboardType="email-address"
						value={email}
						onChangeText={setEmail}
					/>

					<TextInput
						style={styles.input}
						placeholder="Senha"
						secureTextEntry
						value={password}
						onChangeText={setPassword}
					/>

					<Pressable
						style={styles.primaryButton}
						onPress={login}
						disabled={busy}
					>
						<Text style={styles.primaryButtonText}>
							{busy ? "Entrando..." : "Entrar"}
						</Text>
					</Pressable>

					{!!error && <Text style={styles.error}>{error}</Text>}
				</View>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.screen}>
			<ScrollView
				contentContainerStyle={styles.container}
				keyboardShouldPersistTaps="handled"
			>
				<View style={styles.header}>
					<Text style={styles.title}>Controle do relé</Text>

					<Text
						style={[
							styles.status,
							{ color: online ? "#16803d" : "#b42318" },
						]}
					>
						{online
							? "● Dispositivo online"
							: "● Dispositivo offline"}
					</Text>
				</View>

				<View style={styles.card}>
					<Text style={styles.cardLabel}>ESTADO ATUAL</Text>

					<Text style={styles.relayStatus}>
						{relay === null
							? "Aguardando..."
							: relay.enabled
								? "Ligado"
								: "Desligado"}
					</Text>

					<Text style={styles.subtitle}>
						{hasTimer
							? `Tempo restante: ${formatTime(remainingSeconds)}`
							: relay?.enabled
								? "Sem temporizador"
								: "Relé desligado"}
					</Text>

					{!online && (
						<Text style={styles.warning}>
							Exibindo o último estado conhecido.
						</Text>
					)}
				</View>

				<View style={styles.card}>
					<Text style={styles.sectionTitle}>
						Tempo de funcionamento
					</Text>

					<View style={styles.chips}>
						{DURATIONS.map((minutes) => (
							<Pressable
								key={minutes}
								style={[
									styles.chip,
									duration === String(minutes) &&
										styles.chipSelected,
								]}
								onPress={() => setDuration(String(minutes))}
							>
								<Text
									style={[
										styles.chipText,
										duration === String(minutes) &&
											styles.chipTextSelected,
									]}
								>
									{minutes === 0
										? "Sempre"
										: `${minutes} min`}
								</Text>
							</Pressable>
						))}
					</View>

					<Text style={styles.fieldLabel}>
						Ou informe o tempo em minutos (0 = sem limite)
					</Text>

					<TextInput
						style={styles.input}
						value={duration}
						onChangeText={setDuration}
						keyboardType="number-pad"
						placeholder="Minutos"
					/>
				</View>

				<View style={styles.actions}>
					<Pressable
						style={[
							styles.primaryButton,
							styles.actionButton,
							!canSend && styles.disabled,
						]}
						disabled={!canSend}
						onPress={() => sendCommand(true)}
					>
						<Text style={styles.primaryButtonText}>Ligar</Text>
					</Pressable>

					<Pressable
						style={[
							styles.offButton,
							styles.actionButton,
							!canSend && styles.disabled,
						]}
						disabled={!canSend}
						onPress={() => sendCommand(false)}
					>
						<Text style={styles.offButtonText}>Desligar</Text>
					</Pressable>
				</View>

				{!!pendingId && (
					<Text style={styles.subtitle}>
						Comando enviado. Aguardando dispositivo...
					</Text>
				)}

				{!!error && <Text style={styles.error}>{error}</Text>}

				<Pressable onPress={() => signOut(auth)} style={styles.logout}>
					<Text style={styles.logoutText}>Sair da conta</Text>
				</Pressable>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
		backgroundColor: "#f5f6f8",
	},
	container: {
		padding: 24,
		gap: 20,
	},
	center: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	login: {
		flex: 1,
		justifyContent: "center",
		padding: 24,
		gap: 16,
	},
	header: {
		gap: 8,
		marginTop: 20,
	},
	title: {
		fontSize: 28,
		fontWeight: "700",
		color: "#172033",
	},
	subtitle: {
		fontSize: 14,
		color: "#697386",
	},
	status: {
		fontSize: 14,
		fontWeight: "600",
	},
	card: {
		padding: 22,
		gap: 14,
		backgroundColor: "#ffffff",
		borderRadius: 18,
	},
	cardLabel: {
		fontSize: 12,
		fontWeight: "600",
		color: "#8893a5",
		letterSpacing: 1,
	},
	relayStatus: {
		fontSize: 38,
		fontWeight: "700",
		color: "#172033",
	},
	sectionTitle: {
		fontSize: 17,
		fontWeight: "600",
		color: "#172033",
	},
	chips: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 8,
	},
	chip: {
		paddingHorizontal: 14,
		paddingVertical: 10,
		borderRadius: 20,
		backgroundColor: "#eef0f4",
	},
	chipSelected: {
		backgroundColor: "#172033",
	},
	chipText: {
		color: "#445066",
		fontWeight: "500",
	},
	chipTextSelected: {
		color: "#ffffff",
	},
	fieldLabel: {
		fontSize: 13,
		color: "#697386",
	},
	input: {
		borderWidth: 1,
		borderColor: "#dce0e6",
		backgroundColor: "#ffffff",
		padding: 14,
		borderRadius: 10,
		fontSize: 16,
		color: "#172033",
	},
	actions: {
		flexDirection: "row",
		gap: 12,
	},
	actionButton: {
		flex: 1,
		alignItems: "center",
	},
	primaryButton: {
		backgroundColor: "#187b4a",
		padding: 16,
		borderRadius: 12,
		alignItems: "center",
	},
	primaryButtonText: {
		color: "#ffffff",
		fontWeight: "700",
		fontSize: 16,
	},
	offButton: {
		backgroundColor: "#ffffff",
		borderWidth: 1,
		borderColor: "#dce0e6",
		borderRadius: 12,
		padding: 16,
	},
	offButtonText: {
		color: "#b42318",
		fontWeight: "700",
		fontSize: 16,
	},
	disabled: {
		opacity: 0.4,
	},
	warning: {
		color: "#b26a12",
		fontSize: 12,
	},
	error: {
		color: "#b42318",
		fontSize: 13,
	},
	logout: {
		alignItems: "center",
		padding: 12,
	},
	logoutText: {
		color: "#697386",
	},
});
