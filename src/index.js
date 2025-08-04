export default {
	async fetch(request, env, ctx) {
		if (request.method === "OPTIONS") return handleOptions();

		const url = new URL(request.url);

		// ✅ Availability endpoint
		if (request.method === "GET" && url.pathname === "/availability") {
			const caseManagerEmail = url.searchParams.get("cm");
			if (!caseManagerEmail) {
				return new Response("Missing case manager email", { status: 400 });
			}

			try {
				const token = await getAccessToken(env);
				console.log("✅ Access token retrieved for availability");
				const busySlots = await getBusySlots(token, caseManagerEmail);
				return new Response(JSON.stringify({ busy: busySlots }), {
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": "*",
					},
				});
			} catch (err) {
				console.error("❌ Availability check failed:", err);
				return new Response("Server error", { status: 500 });
			}
		}

		// ✅ Booking endpoint
		if (request.method === "POST") {
			try {
				const contentType = request.headers.get("content-type") || "";
				let data = {};

				if (contentType.includes("application/json")) {
					data = await request.json();
				} else if (contentType.includes("application/x-www-form-urlencoded")) {
					const formData = await request.formData();
					for (const [key, value] of formData.entries()) {
						data[key] = value;
					}
				} else {
					return new Response("Unsupported content type", { status: 415 });
				}

				const { name, email, phone, selectedTime, cm } = data;

				if (!name || !email || !selectedTime || !cm) {
					return new Response("Missing required fields", { status: 400 });
				}

				const accessToken = await getAccessToken(env);
				console.log("✅ Access token retrieved for booking");

				const created = await createEvent(
					accessToken,
					selectedTime,
					name,
					email,
					phone,
					cm
				);

				if (!created) throw new Error("Failed to create event");

				return new Response(
					JSON.stringify({ success: true, message: "Event created." }),
					{
						status: 200,
						headers: {
							"content-type": "application/json",
							"Access-Control-Allow-Origin": "*",
						},
					}
				);
			} catch (err) {
				console.error("❌ Booking error:", err);
				return new Response("Server error", { status: 500 });
			}
		}

		return new Response("Not Found", { status: 404 });
	},
};

async function getAccessToken(env) {
	const tokenUrl = `https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`;

	const body = new URLSearchParams();
	body.set("grant_type", "client_credentials");
	body.set("client_id", env.CLIENT_ID);
	body.set("client_secret", env.CLIENT_SECRET);
	body.set("scope", "https://graph.microsoft.com/.default");

	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});

	const data = await res.json();
	if (!res.ok) {
		console.error("❌ Token fetch failed:", data);
		throw new Error("Token request failed");
	}

	return data.access_token;
}

async function createEvent(token, selectedTime, name, email, phone, calendarOwner) {
	const endpoint = `https://graph.microsoft.com/v1.0/users/${calendarOwner}/events`;

	const localTime = new Date(selectedTime);
	const utcTime = new Date(localTime.getTime() - localTime.getTimezoneOffset() * 60000);
	const endUtc = new Date(utcTime.getTime() + 30 * 60 * 1000); // 30 min duration

	const body = {
		subject: `📅 Appointment with ${name}`,
		body: {
			contentType: "HTML",
			content: `Client: ${name}<br>Email: ${email}<br>Phone: ${phone || "N/A"}`,
		},
		start: {
			dateTime: utcTime.toISOString(),
			timeZone: "UTC",
		},
		end: {
			dateTime: endUtc.toISOString(),
			timeZone: "UTC",
		},
		attendees: [
			{
				emailAddress: { address: email, name },
				type: "required",
			},
			{
				emailAddress: { address: "calendar@fivestartaxhelp.com", name: "Team Calendar" },
				type: "optional", // avoid triggering conflicts
			}
		],

	};

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const result = await res.json();
	if (!res.ok) {
		console.error("❌ Create event failed:", result);
		return false;
	}

	console.log("✅ Event created:", result.id);
	return true;
}

async function getBusySlots(token, email) {
	const now = new Date();
	const start = now.toISOString();
	const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days from now

	const url = `https://graph.microsoft.com/v1.0/users/${email}/calendar/getSchedule`;
	const body = {
		schedules: [email],
		startTime: { dateTime: start, timeZone: "UTC" },
		endTime: { dateTime: end, timeZone: "UTC" },
		availabilityViewInterval: 30,
	};

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const json = await res.json();
	if (!res.ok) {
		console.error("❌ Failed to get schedule:", json);
		throw new Error("Failed to get schedule");
	}

	const schedule = json.value?.[0];
	if (!schedule || !schedule.scheduleItems) return [];

	return schedule.scheduleItems.map((item) => ({
		start: item.start.dateTime,
		end: item.end.dateTime,
	}));
}

function handleOptions() {
	return new Response(null, {
		status: 204,
		headers: {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
}
